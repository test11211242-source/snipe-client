import { describe, expect, it } from 'vitest'

import {
  GameLayoutWireSchema,
  MonitorCommandLayoutSchema,
  MonitorPrimarySchema,
  MonitorProcessEventSchema,
  MonitorStartCommandSchema,
  MonitorVsOrientationTriggerSchema,
  MonitorWindowChromeSchema,
} from './monitor-protocol'
import {
  monitorGamePrimaryFixture,
  monitorLearnedLayoutFixture,
} from '../../tests/monitor-fixtures'
import { GAME_ASPECT_MIN, GAME_ASPECT_MAX, gameAspectsOverlap } from './game-aspect'

const sessionId = '00000000-0000-4000-8000-000000000020'

function event(type: string, payload: unknown) {
  return { protocolVersion: 4, sessionId, sequence: 1, type, payload }
}

describe('monitor protocol v4', () => {
  it('preserves the exact detector algorithm bounds', () => {
    expect(GAME_ASPECT_MIN).toBe((9 / 22) * 0.97)
    expect(GAME_ASPECT_MAX).toBe((3 / 4) * 1.03)
  })

  it('accepts game-relative commands and rejects old versions and old top-level fields', () => {
    const command = {
      protocolVersion: 4,
      sessionId,
      sequence: 0,
      type: 'start',
      payload: {
        selector: { kind: 'window', windowHwnd: '123' },
        primary: monitorGamePrimaryFixture(),
        capturePolicy: 'immediate_nickname',
        limits: {
          fps: 10,
          maxImageBytes: 10 * 1024 * 1024,
          maxImagePixels: 20_000_000,
          maxImageWidth: 8192,
          maxImageHeight: 8192,
          confirmationsNeeded: 2,
          confirmationDecay: 0.5,
          cooldownSeconds: 15,
        },
        prediction: null,
      },
    }
    expect(MonitorStartCommandSchema.parse(command)).toEqual(command)
    expect(
      MonitorStartCommandSchema.safeParse({ ...command, protocolVersion: 3 }).success,
    ).toBe(false)
    expect(MonitorStartCommandSchema.safeParse({ ...command, sequence: 1 }).success).toBe(
      false,
    )
    for (const field of ['regions', 'triggerProfile', 'configuredFrameSize']) {
      expect(
        MonitorStartCommandSchema.safeParse({
          ...command,
          payload: { ...command.payload, [field]: {} },
        }).success,
      ).toBe(false)
    }
  })

  it('keeps command layouts distinct from learned wire and persisted layouts', () => {
    const layout = monitorGamePrimaryFixture().layouts[0]
    if (layout === undefined) throw new Error('Missing game layout fixture')
    expect(MonitorCommandLayoutSchema.parse(layout)).toEqual(layout)
    for (const field of [
      'provenance',
      'referenceFrameSize',
      'referenceGameRect',
      'confidence',
      'expectedLayout',
    ]) {
      expect(
        MonitorCommandLayoutSchema.safeParse({ ...layout, [field]: {} }).success,
      ).toBe(false)
    }
    const withoutTimestamp: Partial<typeof layout> = { ...layout }
    delete withoutTimestamp.calibratedAt
    const withoutSource: Partial<typeof layout> = { ...layout }
    delete withoutSource.layoutSource
    expect(MonitorCommandLayoutSchema.safeParse(withoutTimestamp).success).toBe(false)
    expect(MonitorCommandLayoutSchema.safeParse(withoutSource).success).toBe(false)
    const learned = monitorLearnedLayoutFixture()
    expect(GameLayoutWireSchema.parse(learned)).toEqual(learned)
    expect(GameLayoutWireSchema.safeParse({ ...learned, provenance: {} }).success).toBe(
      false,
    )
    expect(
      GameLayoutWireSchema.safeParse({ ...learned, layoutSource: 'setup' }).success,
    ).toBe(false)
    expect(
      GameLayoutWireSchema.safeParse({ ...learned, calibratedAt: 'yesterday' }).success,
    ).toBe(false)
    expect(GameLayoutWireSchema.safeParse({ ...learned, confidence: 1.01 }).success).toBe(
      false,
    )
  })

  it('enforces 1..4 layouts, a setup layout, unique IDs and distinct aspects', () => {
    const primary = monitorGamePrimaryFixture()
    const layout = primary.layouts[0]
    if (layout === undefined) throw new Error('Missing game layout fixture')
    expect(MonitorPrimarySchema.parse(primary)).toEqual(primary)
    for (const layouts of [
      [],
      [layout, layout],
      [{ ...layout, layoutSource: 'learned' }],
      [layout, { ...layout, layoutId: sessionId, gameAspect: 0.57 }],
      Array.from({ length: 5 }, (_, index) => ({
        ...layout,
        layoutId: sessionId,
        gameAspect: 0.4 + index * 0.08,
      })),
      [{ ...layout, gameAspect: 0.396 }],
      [{ ...layout, gameAspect: 0.774 }],
    ]) {
      expect(MonitorPrimarySchema.safeParse({ ...primary, layouts }).success).toBe(false)
    }
    expect(
      MonitorPrimarySchema.safeParse({
        ...primary,
        layouts: [
          layout,
          { ...layout, layoutId: sessionId, gameAspect: 0.75, layoutSource: 'learned' },
        ],
      }).success,
    ).toBe(true)
    expect(
      MonitorPrimarySchema.safeParse({
        ...primary,
        learning: { enabled: true, maxLayouts: 5 },
      }).success,
    ).toBe(false)
    expect(
      MonitorPrimarySchema.safeParse({
        ...primary,
        configuredFrameSize: { width: 1, height: 1 },
      }).success,
    ).toBe(false)
  })

  it.each([GAME_ASPECT_MIN, GAME_ASPECT_MAX, (GAME_ASPECT_MIN + 0.397) / 2])(
    'accepts exact detector-range aspect %s in commands and learned events',
    (gameAspect) => {
      const layout = monitorGamePrimaryFixture().layouts[0]
      if (layout === undefined) throw new Error('Missing game layout fixture')
      expect(MonitorCommandLayoutSchema.parse({ ...layout, gameAspect }).gameAspect).toBe(
        gameAspect,
      )
      const learned = { ...monitorLearnedLayoutFixture(), gameAspect }
      expect(
        MonitorProcessEventSchema.parse(
          event('layout_learned', {
            calibrationId: sessionId,
            layout: learned,
            triggerId: null,
          }),
        ),
      ).toMatchObject({ payload: { layout: { gameAspect } } })
    },
  )

  it.each([GAME_ASPECT_MIN - Number.EPSILON, GAME_ASPECT_MAX + Number.EPSILON])(
    'rejects aspect %s outside the exact detector range',
    (gameAspect) => {
      const layout = monitorGamePrimaryFixture().layouts[0]
      if (layout === undefined) throw new Error('Missing game layout fixture')
      expect(
        MonitorCommandLayoutSchema.safeParse({ ...layout, gameAspect }).success,
      ).toBe(false)
      expect(
        GameLayoutWireSchema.safeParse({ ...monitorLearnedLayoutFixture(), gameAspect })
          .success,
      ).toBe(false)
    },
  )

  it.each([false, true])(
    'keeps +3.05%% learned aspects distinct in either layout order (reverse=%s)',
    (reverse) => {
      const primary = monitorGamePrimaryFixture()
      const setup = primary.layouts[0]
      if (setup === undefined) throw new Error('Missing game layout fixture')
      const learned = {
        ...setup,
        layoutId: sessionId,
        layoutSource: 'learned' as const,
        gameAspect: setup.gameAspect * 1.0305,
      }
      const layouts = reverse ? [learned, setup] : [setup, learned]
      expect(gameAspectsOverlap(setup.gameAspect, learned.gameAspect)).toBe(false)
      expect(gameAspectsOverlap(learned.gameAspect, setup.gameAspect)).toBe(false)
      const parsed = MonitorPrimarySchema.parse({ ...primary, layouts })
      if (parsed.kind !== 'game_relative')
        throw new Error('Expected game-relative primary')
      expect(parsed.layouts).toEqual(layouts)
      const overlapping = { ...learned, gameAspect: setup.gameAspect * 1.0299 }
      expect(
        MonitorPrimarySchema.safeParse({
          ...primary,
          layouts: reverse ? [overlapping, setup] : [setup, overlapping],
        }).success,
      ).toBe(false)
    },
  )

  it('validates orientation template byte counts, canonical base64 and algorithm constants', () => {
    const layout = monitorGamePrimaryFixture().layouts[0]
    if (layout === undefined) throw new Error('Missing game layout fixture')
    const trigger = layout.trigger
    expect(MonitorVsOrientationTriggerSchema.parse(trigger)).toEqual(trigger)
    for (const patch of [
      { angleQ8Base64: 'AAAA' },
      { weightQ8Base64: '!!!!' },
      { angleQ8Base64: Buffer.alloc(96 * 64 - 1).toString('base64') },
      { normalizedSize: { width: 95, height: 64 } },
      { normalizedSize: { width: 96, height: 161 } },
      { threshold: 0.51 },
      { cropMargin: 0.09 },
      { maxShift: 4 },
      { templateHash64: 'G123456789abcdef' },
      { maskAreaRatio: -0.1 },
      { badge: { cx: 0, cy: 0.5, width: 0.2, height: 0.1 } },
      { color: 'blue' },
    ]) {
      expect(
        MonitorVsOrientationTriggerSchema.safeParse({ ...trigger, ...patch }).success,
      ).toBe(false)
    }
  })

  it('validates strip edge bytes and strict nested chrome shapes', () => {
    const layout = monitorGamePrimaryFixture().layouts[0]
    if (layout === undefined) throw new Error('Missing game layout fixture')
    const chrome = layout.windowChrome
    const strip = {
      length: 256,
      thickness: 1,
      angleQ8Base64: Buffer.alloc(256).toString('base64'),
      weightQ8Base64: Buffer.alloc(256, 255).toString('base64'),
    }
    expect(
      MonitorWindowChromeSchema.safeParse({ ...chrome, top: 1, topEdges: strip }).success,
    ).toBe(true)
    for (const patch of [
      { top: 2049 },
      { left: -1 },
      { top: 0.5 },
      { topEdges: { ...strip, thickness: 257 } },
      { topEdges: { ...strip, weightQ8Base64: 'AAAA' } },
      {
        topEdges: {
          ...strip,
          angleQ8Base64: strip.angleQ8Base64.replace(/AA==$/, 'AB=='),
        },
      },
      { topEdges: { ...strip, color: 'red' } },
    ]) {
      expect(MonitorWindowChromeSchema.safeParse({ ...chrome, ...patch }).success).toBe(
        false,
      )
    }
  })

  it.each([
    [
      'geometry',
      {
        state: 'armed',
        frameWidth: 1200,
        frameHeight: 1600,
        gameRect: { x: 0, y: 0, width: 1200, height: 1600 },
        gameAspect: 0.75,
        layoutId: sessionId,
      },
    ],
    [
      'geometry',
      {
        state: 'no_game',
        frameWidth: 1200,
        frameHeight: 1600,
        gameRect: null,
        gameAspect: null,
        layoutId: null,
      },
    ],
    ['learning', { status: 'waiting_vs', reason: null, rejectedCount: 0 }],
    ['learning', { status: 'rejected', reason: 'LAYOUT_LIMIT', rejectedCount: 1 }],
    ['learning', { status: 'failed', reason: 'LEARN_GAME_NOT_FOUND', rejectedCount: 2 }],
    [
      'layout_learned',
      {
        calibrationId: sessionId,
        layout: monitorLearnedLayoutFixture(),
        triggerId: null,
      },
    ],
    [
      'layout_learned',
      {
        calibrationId: sessionId,
        layout: monitorLearnedLayoutFixture(),
        triggerId: sessionId,
      },
    ],
    ['prediction_state', { state: 'aspect_mismatch' }],
    ['prediction_state', { state: 'active' }],
  ] as const)('accepts strict %s event payloads', (type, payload) => {
    const value = event(type, payload)
    expect(MonitorProcessEventSchema.parse(value)).toEqual(value)
    expect(
      MonitorProcessEventSchema.safeParse({ ...value, privateField: true }).success,
    ).toBe(false)
    expect(
      MonitorProcessEventSchema.safeParse(event(type, { ...payload, privateField: true }))
        .success,
    ).toBe(false)
  })

  it.each([
    [
      'geometry',
      {
        state: 'armed',
        frameWidth: 0,
        frameHeight: 1600,
        gameRect: null,
        gameAspect: null,
        layoutId: null,
      },
    ],
    [
      'geometry',
      {
        state: 'armed',
        frameWidth: 1200,
        frameHeight: 1600,
        gameRect: { x: -1, y: 0, width: 1, height: 1 },
        gameAspect: 0.75,
        layoutId: sessionId,
      },
    ],
    [
      'geometry',
      {
        state: 'armed',
        frameWidth: 1200,
        frameHeight: 1600,
        gameRect: null,
        gameAspect: 0,
        layoutId: null,
      },
    ],
    ['learning', { status: 'failed', reason: 'AUTO_GAME_NOT_FOUND', rejectedCount: 0 }],
    ['learning', { status: 'failed', reason: null, rejectedCount: -1 }],
    [
      'layout_learned',
      {
        calibrationId: sessionId,
        layout: monitorLearnedLayoutFixture(),
        triggerId: 'invalid',
      },
    ],
    ['prediction_state', { state: 'paused' }],
  ] as const)('rejects malformed %s payloads', (type, payload) => {
    expect(MonitorProcessEventSchema.safeParse(event(type, payload)).success).toBe(false)
  })

  it('requires diagnostic matcher and permits nullable structural metrics', () => {
    const payload = {
      profile: 'primary',
      matcher: 'vs_orientation',
      matched: true,
      score: 0.8,
      support: null,
      orientation: null,
      correlation: null,
      orbInliers: null,
      reason: 'pass',
    }
    expect(
      MonitorProcessEventSchema.safeParse(event('diagnostic', payload)).success,
    ).toBe(true)
    expect(
      MonitorProcessEventSchema.safeParse(
        event('diagnostic', {
          ...payload,
          matcher: 'structural',
          support: 0.9,
          orientation: 0.8,
          correlation: -0.2,
          orbInliers: 3,
        }),
      ).success,
    ).toBe(true)
    const withoutMatcher: Partial<typeof payload> = { ...payload }
    delete withoutMatcher.matcher
    expect(
      MonitorProcessEventSchema.safeParse(event('diagnostic', withoutMatcher)).success,
    ).toBe(false)
    for (const patch of [
      { matcher: 'rgb' },
      { support: 1.1 },
      { correlation: -1.1 },
      { orbInliers: 1.5 },
    ]) {
      expect(
        MonitorProcessEventSchema.safeParse(event('diagnostic', { ...payload, ...patch }))
          .success,
      ).toBe(false)
    }
  })
})
