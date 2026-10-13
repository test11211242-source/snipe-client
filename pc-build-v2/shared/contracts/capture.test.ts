import { describe, expect, it } from 'vitest'

import {
  GameLayoutSchema,
  GameRelativeCalibrationSchema,
  NormalizedRectSchema,
} from '../models/capture'
import { predictionResultMatchesCapture } from '../models/prediction-result'
import { monitorLearnedLayoutFixture } from '../../tests/monitor-fixtures'
import { GameLayoutWireSchema } from './monitor-protocol'
import {
  CapturePreparationResponseSchema,
  SetRegionPayloadSchema,
  StartSetupPayloadSchema,
} from './capture-ipc'

describe('capture contracts', () => {
  it('accepts bounded normalized rectangles and rejects overflow', () => {
    expect(
      NormalizedRectSchema.parse({ x: 0.2, y: 0.1, width: 0.8, height: 0.9 }),
    ).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.8,
      height: 0.9,
    })
    for (const rect of [
      { x: -0.1, y: 0, width: 0.5, height: 0.5 },
      { x: 0.8, y: 0, width: 0.3, height: 0.5 },
      { x: 0, y: 0.9, width: 0.5, height: 0.2 },
      { x: 0, y: 0, width: 0, height: 1 },
    ]) {
      expect(NormalizedRectSchema.safeParse(rect).success).toBe(false)
    }
  })

  it('rejects renderer fields outside the narrow command DTO', () => {
    expect(() =>
      SetRegionPayloadSchema.parse({
        sessionId: 'd52a21a9-3794-4a51-a292-60ec1ce9c238',
        generation: 1,
        region: 'trigger',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        hwnd: '123',
      }),
    ).toThrow()
    expect(() =>
      StartSetupPayloadSchema.parse({
        preparationId: 'd52a21a9-3794-4a51-a292-60ec1ce9c238',
        windowHwnd: '123',
      }),
    ).toThrow()
  })

  it('returns bounded public preparation failures without rejecting IPC', () => {
    expect(
      CapturePreparationResponseSchema.parse({
        ok: false,
        error: {
          code: 'CAPTURE_SOURCE_STALE',
          message: 'Capture sources changed or expired; refresh the list',
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'CAPTURE_SOURCE_STALE' } })
    expect(() =>
      CapturePreparationResponseSchema.parse({
        ok: false,
        error: { code: 'CAPTURE_SOURCE_STALE', message: 'stale' },
        internalPath: 'C:\\private',
      }),
    ).toThrow()
  })
})

describe('M9 calibration and result binding', () => {
  const wire = monitorLearnedLayoutFixture()
  const { confidence, zonesOrigin: _origins, ...fields } = wire
  void _origins
  const provenance = { origin: 'auto' as const, confidence, analyzerVersion: 'm9-geom-1' }
  const setup = GameLayoutSchema.parse({
    ...fields,
    layoutSource: 'setup',
    provenance: {
      trigger: { ...provenance, analyzerVersion: 'vs-orient-1' },
      nickname: provenance,
      topLeftEvidence: provenance,
      viewport: provenance,
    },
  })
  const calibration = {
    schemaVersion: 2,
    coordinateSpace: 'game_relative',
    calibrationId: wire.layoutId,
    revision: 1,
    layouts: [setup],
    validationStatus: 'validated',
    calibratedAt: wire.calibratedAt,
  }

  it('accepts strict game-relative calibration with a protected setup layout', () => {
    expect(GameRelativeCalibrationSchema.parse(calibration).layouts).toEqual([setup])
    expect(
      GameRelativeCalibrationSchema.safeParse({
        ...calibration,
        layouts: [{ ...setup, layoutSource: 'learned' }],
      }).success,
    ).toBe(false)
  })

  it('rejects duplicate ids, overlapping aspects and more than four layouts', () => {
    for (const layouts of [
      [setup, { ...setup, gameAspect: 0.5 }],
      [
        setup,
        { ...setup, layoutId: '00000000-0000-4000-8000-000000000020', gameAspect: 0.74 },
      ],
      Array.from({ length: 5 }, (_, index) => ({
        ...setup,
        layoutId: `00000000-0000-4000-8000-00000000002${index}`,
        gameAspect: 0.4 + index * 0.08,
      })),
    ]) {
      expect(
        GameRelativeCalibrationSchema.safeParse({ ...calibration, layouts }).success,
      ).toBe(false)
    }
  })

  it('requires canonical exact-length orientation and strip templates', () => {
    if (setup.trigger.kind !== 'vs_edge_orientation')
      throw new Error('Missing VS fixture')
    expect(
      GameLayoutSchema.safeParse({
        ...setup,
        trigger: { ...setup.trigger, angleQ8Base64: 'AAAA' },
      }).success,
    ).toBe(false)
    expect(
      GameLayoutSchema.safeParse({
        ...setup,
        windowChrome: {
          ...setup.windowChrome,
          topEdges: {
            length: 256,
            thickness: 1,
            angleQ8Base64: 'AAAA',
            weightQ8Base64: 'AAAA',
          },
        },
      }).success,
    ).toBe(false)
  })

  it('requires both learned zone origins and rejects unknown origins', () => {
    const { zonesOrigin: _zonesOrigin, ...missing } = wire
    void _zonesOrigin
    expect(GameLayoutWireSchema.safeParse(missing).success).toBe(false)
    expect(
      GameLayoutWireSchema.safeParse({
        ...wire,
        zonesOrigin: { nickname: 'imported', topLeftEvidence: 'auto' },
      }).success,
    ).toBe(false)
    expect(
      GameLayoutWireSchema.parse({
        ...wire,
        zonesOrigin: { nickname: 'manual', topLeftEvidence: 'auto' },
      }).zonesOrigin.nickname,
    ).toBe('manual')
  })

  it('keeps result bindings across game layout revisions but invalidates recalibration', () => {
    const result = {
      captureProfileId: wire.layoutId,
      captureCalibrationId: wire.layoutId,
      captureConfigurationRevision: 1,
      captureConfigurationFingerprint: 'a'.repeat(64),
    }
    const capture = {
      profileId: wire.layoutId,
      calibrationId: wire.layoutId,
      configurationRevision: 2,
      configurationFingerprint: 'b'.repeat(64),
    }
    expect(predictionResultMatchesCapture(result as never, capture)).toBe(true)
    expect(
      predictionResultMatchesCapture(result as never, {
        ...capture,
        calibrationId: '00000000-0000-4000-8000-000000000099',
      }),
    ).toBe(false)
    expect(
      predictionResultMatchesCapture(result as never, {
        ...capture,
        profileId: '00000000-0000-4000-8000-000000000099',
      }),
    ).toBe(false)
  })

  it('retains full-frame fingerprint/revision binding without accepting game bindings', () => {
    const result = {
      captureProfileId: wire.layoutId,
      captureConfigurationRevision: 1,
      captureConfigurationFingerprint: 'a'.repeat(64),
    }
    const capture = {
      profileId: wire.layoutId,
      configurationRevision: 1,
      configurationFingerprint: 'a'.repeat(64),
    }
    expect(predictionResultMatchesCapture(result as never, capture)).toBe(true)
    expect(
      predictionResultMatchesCapture(result as never, {
        ...capture,
        configurationRevision: 2,
      }),
    ).toBe(false)
    expect(
      predictionResultMatchesCapture(
        { ...result, captureCalibrationId: wire.layoutId } as never,
        capture,
      ),
    ).toBe(false)
  })
})
