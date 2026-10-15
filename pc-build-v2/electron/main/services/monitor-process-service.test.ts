import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MonitorStartPayload } from '../../../shared/contracts/monitor-protocol'
import {
  monitorGamePrimaryFixture,
  monitorLearnedLayoutFixture,
} from '../../../tests/monitor-fixtures'
import {
  MonitorProcessService,
  type MonitorChild,
  type MonitorProcessListener,
} from './monitor-process-service'

function payload(): MonitorStartPayload {
  return {
    selector: { kind: 'window', windowHwnd: '123' },
    primary: {
      kind: 'full_frame',
      configuredFrameSize: { width: 1920, height: 1080 },
      regions: {
        trigger: { x: 0, y: 0, width: 0.2, height: 0.2 },
        nicknameRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
        topLeftEvidenceRegion: { x: 0, y: 0, width: 1, height: 1 },
      },
      triggerProfile: {
        schemaVersion: 3,
        analyzer: { name: 'cr-tools-trigger-analyzer', version: '2.0.0' },
        innerRect: { x: 0, y: 0, width: 1, height: 1 },
        structureAlgorithm: 'max-channel-scharr-v1',
        structureHash64: '0123456789abcdef',
        matcherMode: 'edge',
        normalizedTemplateSize: { width: 128, height: 128 },
        structureTemplateBase64: 'AAAA',
        edgeTemplateBase64: 'AAAA',
        orientationTemplateBase64: 'AAAA',
        quality: {
          grade: 'medium',
          score: 0.65,
          edgePixelCount: 120,
          edgeCoverage: 0.5,
          keypointsCount: 0,
          cropConfidence: 0,
          cropAreaRatio: 1,
        },
      },
    },
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
  }
}

class FakeChild extends EventEmitter implements MonitorChild {
  pid: number | undefined = 4321
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  written = ''
  killed = false

  constructor() {
    super()
    this.stdin.on('data', (chunk) => {
      this.written += Buffer.from(chunk).toString('utf8')
    })
  }

  command(): Record<string, unknown> {
    const line = this.written.split('\n').find((candidate) => candidate.length > 0)
    if (line === undefined) throw new Error('missing command')
    return JSON.parse(line) as Record<string, unknown>
  }

  event(sequence: number, type: string, payloadValue: unknown): void {
    this.stdout.write(
      `${JSON.stringify({
        protocolVersion: 4,
        sessionId: this.command()['sessionId'],
        sequence,
        type,
        payload: payloadValue,
      })}\n`,
    )
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

function listener(): MonitorProcessListener {
  return {
    onTriggered: vi.fn(),
    onAction: vi.fn(),
    onPredictionResult: vi.fn(),
    onGeometry: vi.fn(),
    onLearning: vi.fn(),
    onLayoutLearned: vi.fn(),
    onPredictionState: vi.fn(),
    onFatal: vi.fn(),
    onExit: vi.fn(),
  }
}

function service(child: FakeChild, treeKill = vi.fn().mockResolvedValue(undefined)) {
  const logger = { info: vi.fn(), warn: vi.fn() }
  return {
    treeKill,
    logger,
    value: new MonitorProcessService(
      'python.exe',
      'monitor_engine.py',
      logger,
      vi.fn(() => child),
      treeKill,
    ),
  }
}

afterEach(() => vi.useRealTimers())

describe('MonitorProcessService', () => {
  it('lets Python report no-frame after cold startup before the fallback watchdog', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const test = service(child)
    const events = listener()
    const started = test.value.start(payload(), events)
    const rejected = expect(started).rejects.toMatchObject({ code: 'CAPTURE_NO_FRAME' })
    await vi.advanceTimersByTimeAsync(5_000 + 7_000)
    expect(events.onFatal).not.toHaveBeenCalled()
    child.event(1, 'fatal', {
      code: 'CAPTURE_NO_FRAME',
      message: 'No frame',
      stage: 'start',
    })
    child.emit('close', 0, null)
    await rejected
  })

  it('re-reports stderr on the injected clock and flushes the remaining counters at exit', async () => {
    let clock = 0
    const child = new FakeChild()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const monitor = new MonitorProcessService(
      'python.exe',
      'monitor_engine.py',
      logger,
      () => child,
      vi.fn(),
      { setTimeout, clearTimeout, now: () => clock },
    )
    const started = monitor.start(payload(), listener())
    child.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await started
    child.stderr.write('first\n')
    clock = 4_999
    child.stderr.write('second\n')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    clock = 5_000
    child.stderr.write('third\n')
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn.mock.calls[1]?.[1]).toMatchObject({ bytes: 13, lines: 2 })
    child.stderr.write('tail')
    const stopped = monitor.stop()
    child.emit('close', 0, null)
    await stopped
    expect(logger.warn.mock.calls[2]).toEqual([
      'Monitor final diagnostics suppressed',
      { bytes: 4, lines: 0, incompleteLineBytes: 4 },
    ])
  })
  it('drains unlimited lifetime stderr with bounded rate-limited metadata', async () => {
    const child = new FakeChild()
    const test = service(child)
    const events = listener()
    const started = test.value.start(payload(), events)
    child.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await started
    for (let index = 0; index < 100; index += 1)
      child.stderr.write(`private warning ${index}\n`)
    child.stderr.write(Buffer.alloc(1024 * 1024, 97))
    child.stderr.write('split')
    child.stderr.write('\n')
    expect(events.onFatal).not.toHaveBeenCalled()
    expect(child.killed).toBe(false)
    expect(test.logger.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain('private')
    const stopped = test.value.stop()
    child.emit('close', 0, null)
    await stopped
  })

  it('preserves a structured startup fatal instead of replacing it with early exit', async () => {
    const child = new FakeChild()
    const test = service(child)
    const events = listener()
    const started = test.value.start(payload(), events)
    const rejected = expect(started).rejects.toMatchObject({
      code: 'CAPTURE_START_FAILED',
    })
    child.event(1, 'fatal', {
      code: 'CAPTURE_START_FAILED',
      message: 'Capture could not start',
    })
    child.emit('close', 0, null)
    await rejected
    expect(events.onFatal).toHaveBeenCalledOnce()
  })
  it('reserves ownership before beforeSpawn and cancels a deferred spawn', async () => {
    let release!: () => void
    const beforeSpawn = new Promise<void>((resolve) => {
      release = resolve
    })
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const monitor = new MonitorProcessService(
      'python.exe',
      'monitor_engine.py',
      { info: vi.fn(), warn: vi.fn() },
      spawn,
      vi.fn().mockResolvedValue(undefined),
      undefined,
      () => beforeSpawn,
    )

    const starting = monitor.start(payload(), listener())
    const cancelled = expect(starting).rejects.toMatchObject({
      code: 'MONITOR_START_CANCELLED',
    })
    await expect(monitor.start(payload(), listener())).rejects.toMatchObject({
      code: 'MONITOR_PROCESS_OWNED',
    })
    await expect(monitor.stop()).resolves.toBeUndefined()
    await cancelled
    release()
    await Promise.resolve()
    expect(spawn).not.toHaveBeenCalled()

    const restarted = monitor.start(payload(), listener())
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    child.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await expect(restarted).resolves.toBeDefined()
    const stopping = monitor.stop()
    child.emit('close', 0, null)
    await stopping
  })

  it('uses no shell, sends one start line, accepts one ready, and stops gracefully', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const monitor = new MonitorProcessService(
      'python.exe',
      'monitor_engine.py',
      { info: vi.fn(), warn: vi.fn() },
      spawn,
      vi.fn().mockResolvedValue(undefined),
    )
    const started = monitor.start(payload(), listener())
    expect(spawn).toHaveBeenCalledWith(
      'python.exe',
      ['-B', 'monitor_engine.py'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    )
    expect(child.written.trim().split('\n')).toHaveLength(1)
    expect(child.command()['protocolVersion']).toBe(4)
    child.event(1, 'ready', { frameWidth: 1920, frameHeight: 1080 })
    await expect(started).resolves.toBe(child.command()['sessionId'])
    const stopped = monitor.stop()
    const stopLine = child.written.trim().split('\n')[1]
    if (stopLine === undefined) throw new Error('Missing stop command')
    expect(JSON.parse(stopLine) as unknown).toMatchObject({
      protocolVersion: 4,
      type: 'stop',
    })
    expect(child.written.trim().split('\n')).toHaveLength(2)
    child.emit('close', 0, null)
    await expect(stopped).resolves.toBeUndefined()
  })

  it('rejects spawn failure, no-ready timeout, malformed output, and duplicate ready', async () => {
    await expect(
      new MonitorProcessService(
        'python',
        'worker',
        { info: vi.fn(), warn: vi.fn() },
        () => {
          throw new Error('spawn failed')
        },
        vi.fn(),
      ).start(payload(), listener()),
    ).rejects.toMatchObject({ code: 'MONITOR_START_FAILED' })

    vi.useFakeTimers()
    const timedOut = new FakeChild()
    const timeoutService = service(timedOut)
    const waiting = timeoutService.value.start(payload(), listener())
    const timedOutExpectation = expect(waiting).rejects.toMatchObject({
      code: 'MONITOR_READY_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await timedOutExpectation
    expect(timeoutService.treeKill).toHaveBeenCalledWith(4321)
    timedOut.emit('close', 1, null)

    vi.useRealTimers()
    const malformed = new FakeChild()
    const malformedService = service(malformed)
    const malformedStart = malformedService.value.start(payload(), listener())
    malformed.stdout.write('{bad json}\n')
    await expect(malformedStart).rejects.toMatchObject({
      code: 'MONITOR_PROTOCOL_INVALID',
    })
    expect(malformedService.treeKill).toHaveBeenCalled()

    const duplicate = new FakeChild()
    const duplicateListener = listener()
    const duplicateService = service(duplicate)
    const duplicateStart = duplicateService.value.start(payload(), duplicateListener)
    duplicate.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await duplicateStart
    duplicate.event(2, 'ready', { frameWidth: 10, frameHeight: 10 })
    expect(duplicateListener.onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MONITOR_DUPLICATE_READY' }),
    )
    duplicate.emit('close', 1, null)
  })

  it('validates action PNG size/dimensions and forces a process tree stop after deadline', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const processListener = listener()
    const monitored = service(child)
    const started = monitored.value.start(payload(), processListener)
    child.event(1, 'ready', { frameWidth: 20, frameHeight: 10 })
    await started
    const image = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
    image.write('IHDR', 12, 'ascii')
    image.writeUInt32BE(20, 16)
    image.writeUInt32BE(10, 20)
    child.event(2, 'diagnostic', {
      profile: 'primary',
      matcher: 'structural',
      matched: false,
      score: 0.61,
      support: 0.65,
      orientation: 0.7,
      correlation: 0.2,
      orbInliers: 3,
      reason: 'structure_below_threshold',
    })
    expect(monitored.logger.info).toHaveBeenCalledWith(
      'Trigger diagnostic',
      expect.objectContaining({ profile: 'primary', score: 0.61 }),
    )
    child.event(3, 'triggered', {
      timestamp: '2026-07-12T12:00:00.000Z',
      triggerId: '19d970c1-fc4f-4bea-a767-8f108d3b8739',
    })
    expect(processListener.onTriggered).toHaveBeenCalledWith(
      '2026-07-12T12:00:00.000Z',
      '19d970c1-fc4f-4bea-a767-8f108d3b8739',
    )
    child.event(4, 'action', {
      timestamp: '2026-07-12T12:00:00.000Z',
      triggerId: '19d970c1-fc4f-4bea-a767-8f108d3b8739',
      width: 20,
      height: 10,
      byteLength: image.byteLength,
      imageBase64: image.toString('base64'),
    })
    expect(processListener.onAction).toHaveBeenCalledWith(
      expect.objectContaining({ width: 20, height: 10, image }),
    )
    child.event(5, 'prediction_result', {
      timestamp: '2026-07-12T12:00:01.000Z',
      triggerId: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
      width: 20,
      height: 10,
      byteLength: image.byteLength,
      imageBase64: image.toString('base64'),
    })
    expect(processListener.onPredictionResult).toHaveBeenCalledWith(
      expect.objectContaining({ width: 20, height: 10, image }),
    )
    const stopping = monitored.value.stop()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(monitored.treeKill).toHaveBeenCalledWith(4321)
    child.emit('close', null, 'SIGTERM')
    await expect(stopping).resolves.toBeUndefined()
  })

  it('ignores events and closes from an old child generation', async () => {
    const first = new FakeChild()
    const firstListener = listener()
    const second = new FakeChild()
    const children = [first, second]
    const monitor = new MonitorProcessService(
      'python',
      'worker',
      { info: vi.fn(), warn: vi.fn() },
      vi.fn(() => {
        const child = children.shift()
        if (child === undefined) throw new Error('missing child')
        return child
      }),
      vi.fn().mockResolvedValue(undefined),
    )
    const firstStart = monitor.start(payload(), firstListener)
    first.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await firstStart
    const firstStop = monitor.stop()
    first.emit('close', 0, null)
    await firstStop

    const secondListener = listener()
    const secondStart = monitor.start(payload(), secondListener)
    second.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await secondStart
    first.event(2, 'fatal', { code: 'OLD', message: 'old event' })
    first.emit('close', 1, null)
    expect(secondListener.onFatal).not.toHaveBeenCalled()
  })

  it('stops safely during readiness and rejects out-of-order or oversized output', async () => {
    const stoppingChild = new FakeChild()
    const stoppingService = service(stoppingChild)
    const starting = stoppingService.value.start(payload(), listener())
    const startingExpectation = expect(starting).rejects.toMatchObject({
      code: 'MONITOR_EXITED_EARLY',
    })
    const stopped = stoppingService.value.stop()
    stoppingChild.emit('close', 0, null)
    await startingExpectation
    await stopped

    const sequenceChild = new FakeChild()
    const sequenceListener = listener()
    const sequenceService = service(sequenceChild)
    const sequenceStart = sequenceService.value.start(payload(), sequenceListener)
    sequenceChild.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await sequenceStart
    sequenceChild.event(1, 'stopped', {})
    expect(sequenceListener.onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MONITOR_PROTOCOL_SEQUENCE' }),
    )
    sequenceChild.emit('close', 1, null)

    const oversizedChild = new FakeChild()
    const oversizedService = service(oversizedChild)
    const oversizedStart = oversizedService.value.start(payload(), listener())
    const oversizedExpectation = expect(oversizedStart).rejects.toMatchObject({
      code: 'MONITOR_PROTOCOL_OVERSIZED',
    })
    oversizedChild.stdout.write(Buffer.alloc(14 * 1024 * 1024 + 1, 65))
    await oversizedExpectation
    oversizedChild.emit('close', 1, null)
  })

  it('handles asynchronous child start errors without exposing diagnostics', async () => {
    const child = new FakeChild()
    const processListener = listener()
    const monitored = service(child)
    const started = monitored.value.start(payload(), processListener)
    const expectation = expect(started).rejects.toMatchObject({
      code: 'MONITOR_START_FAILED',
    })
    child.emit('error', new Error('contains-private-process-detail'))
    await expectation
    expect(processListener.onFatal).not.toHaveBeenCalled()
    child.emit('close', 1, null)
  })

  it('bounds a never-resolving tree killer and releases ownership with an error', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const replacement = new FakeChild()
    const children = [child, replacement]
    const monitor = new MonitorProcessService(
      'python.exe',
      'monitor_engine.py',
      { info: vi.fn(), warn: vi.fn() },
      vi.fn(() => {
        const next = children.shift()
        if (next === undefined) throw new Error('missing child')
        return next
      }),
      vi.fn(() => new Promise<void>(() => undefined)),
    )
    const started = monitor.start(payload(), listener())
    child.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await started
    const stopping = monitor.stop()
    const expectation = expect(stopping).rejects.toMatchObject({
      code: 'MONITOR_STOP_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await expectation
    expect(child.killed).toBe(true)

    const nextStart = monitor.start(payload(), listener())
    replacement.event(1, 'ready', { frameWidth: 10, frameHeight: 10 })
    await expect(nextStart).resolves.toBeDefined()
  })

  it('sends game-relative command layouts unchanged and forwards typed lifecycle events', async () => {
    const child = new FakeChild()
    const monitored = service(child)
    const events = listener()
    const primary = monitorGamePrimaryFixture()
    const started = monitored.value.start({ ...payload(), primary }, events)
    expect(child.command()['payload']).toMatchObject({ primary })
    child.event(1, 'ready', { frameWidth: 1200, frameHeight: 1600 })
    await started
    const layout = primary.layouts[0]
    if (layout === undefined) throw new Error('Missing game layout fixture')
    const geometry = {
      state: 'armed',
      frameWidth: 1200,
      frameHeight: 1600,
      gameRect: { x: 0, y: 0, width: 1200, height: 1600 },
      gameAspect: 0.75,
      layoutId: layout.layoutId,
    }
    const learning = { status: 'waiting_vs', reason: null, rejectedCount: 0 }
    const triggerId = '00000000-0000-4000-8000-000000000021'
    const learned = {
      calibrationId: primary.profileCalibrationId,
      layout: monitorLearnedLayoutFixture(),
      triggerId,
    }
    child.event(2, 'geometry', geometry)
    child.event(3, 'learning', learning)
    child.event(4, 'layout_learned', learned)
    child.event(5, 'prediction_state', { state: 'aspect_mismatch' })
    child.event(6, 'triggered', { timestamp: '2026-10-13T00:00:01.000Z', triggerId })
    child.event(7, 'diagnostic', {
      profile: 'primary',
      matcher: 'vs_orientation',
      matched: true,
      score: 0.9,
      support: null,
      orientation: null,
      correlation: null,
      orbInliers: null,
      reason: 'pass',
    })
    expect(events.onGeometry).toHaveBeenCalledWith(geometry)
    expect(events.onLearning).toHaveBeenCalledWith(learning)
    expect(events.onLayoutLearned).toHaveBeenCalledWith(learned)
    expect(events.onPredictionState).toHaveBeenCalledWith({ state: 'aspect_mismatch' })
    expect(events.onTriggered).toHaveBeenCalledWith('2026-10-13T00:00:01.000Z', triggerId)
    expect(monitored.logger.info).toHaveBeenCalledWith(
      'Trigger diagnostic',
      expect.objectContaining({
        matcher: 'vs_orientation',
        support: null,
      }),
    )
    expect(events.onFatal).not.toHaveBeenCalled()
    const stopped = monitored.value.stop()
    child.emit('close', 0, null)
    await stopped
  })

  it('logs one compact line per VS candidate and per geometry state change', async () => {
    const child = new FakeChild()
    const monitored = service(child)
    const events = listener()
    const primary = monitorGamePrimaryFixture()
    const started = monitored.value.start({ ...payload(), primary }, events)
    child.event(1, 'ready', { frameWidth: 1080, frameHeight: 1920 })
    await started
    const candidate = {
      reason: 'cooldown',
      state: 'armed',
      score: 0.9812,
      frames: 18,
      matchedFrames: 17,
      sinceFireS: 11.4,
      frameWidth: 1080,
      frameHeight: 1920,
      gameRect: { x: 0, y: 28, width: 1080, height: 1864 },
      gameAspect: 0.5794,
      layoutAspect: 0.5794,
      kind: 'spectate',
      learnedLayout: true,
      code: null,
      suppressed: 0,
    }
    child.event(2, 'vs_candidate', candidate)
    const geometry = {
      state: 'aspect_mismatch',
      frameWidth: 1080,
      frameHeight: 1920,
      gameRect: { x: 0, y: 45, width: 1080, height: 1847 },
      gameAspect: 0.584732,
      layoutId: null,
    }
    child.event(3, 'geometry', geometry)
    child.event(4, 'geometry', {
      ...geometry,
      gameRect: { x: 0, y: 28, width: 1080, height: 1864 },
    })
    child.event(5, 'learning', {
      status: 'rejected',
      reason: 'LEARN_TRIGGER_WEAK',
      rejectedCount: 1,
    })
    child.event(6, 'source_state', { minimized: true })
    const info = monitored.logger.info.mock.calls
    expect(info).toContainEqual(['VS candidate', candidate])
    expect(info.filter(([message]) => message === 'Monitor geometry')).toEqual([
      [
        'Monitor geometry',
        {
          state: 'aspect_mismatch',
          frameWidth: 1080,
          frameHeight: 1920,
          gameRect: geometry.gameRect,
          gameAspect: 0.5847,
          hasLayout: false,
        },
      ],
    ])
    expect(info).toContainEqual([
      'Monitor learning',
      { status: 'rejected', code: 'LEARN_TRIGGER_WEAK', rejectedCount: 1 },
    ])
    expect(info).toContainEqual(['Monitor source state', { minimized: true }])
    expect(events.onGeometry).toHaveBeenCalledTimes(2)
    child.event(7, 'vs_candidate', { ...candidate, reason: 'late' })
    expect(events.onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MONITOR_PROTOCOL_INVALID' }),
    )
    const stopped = monitored.value.stop()
    child.emit('close', 0, null)
    await stopped
  })

  it('accepts commands above the obsolete 256KiB cap and rejects above 1MiB before spawning', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const monitor = new MonitorProcessService(
      'python.exe',
      'monitor_engine.py',
      { info: vi.fn(), warn: vi.fn() },
      spawn,
      vi.fn().mockResolvedValue(undefined),
    )
    const primary = monitorGamePrimaryFixture()
    const strip = {
      length: 256 as const,
      thickness: 192,
      angleQ8Base64: Buffer.alloc(256 * 192).toString('base64'),
      weightQ8Base64: Buffer.alloc(256 * 192, 255).toString('base64'),
    }
    const layout = primary.layouts[0]
    if (layout === undefined) throw new Error('Missing game layout fixture')
    layout.windowChrome = {
      top: 192,
      bottom: 192,
      left: 192,
      right: 192,
      topEdges: strip,
      bottomEdges: strip,
      leftEdges: strip,
      rightEdges: strip,
    }
    const started = monitor.start({ ...payload(), primary }, listener())
    expect(Buffer.byteLength(child.written.trim(), 'utf8')).toBeGreaterThan(256 * 1024)
    expect(Buffer.byteLength(child.written.trim(), 'utf8')).toBeLessThan(1024 * 1024)
    child.event(1, 'ready', { frameWidth: 1200, frameHeight: 1600 })
    await started
    const stopped = monitor.stop()
    child.emit('close', 0, null)
    await stopped
    primary.layouts.push({
      ...layout,
      layoutId: '00000000-0000-4000-8000-000000000022',
      layoutSource: 'learned',
      gameAspect: 0.75,
    })
    await expect(
      monitor.start({ ...payload(), primary }, listener()),
    ).rejects.toMatchObject({
      code: 'MONITOR_PROTOCOL_OVERSIZED',
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(child.written.trim().split('\n')).toHaveLength(2)
  })

  it('includes the JSONL newline in the 1MiB command limit', async () => {
    const child = new FakeChild()
    const monitored = service(child)
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockReturnValue(1024 * 1024)
    try {
      await expect(monitored.value.start(payload(), listener())).rejects.toMatchObject({
        code: 'MONITOR_PROTOCOL_OVERSIZED',
      })
      expect(child.written).toBe('')
    } finally {
      byteLength.mockRestore()
    }
  })

  it('rejects malformed new events and events before ready without invoking their callbacks', async () => {
    const earlyChild = new FakeChild()
    const early = service(earlyChild)
    const earlyEvents = listener()
    const earlyStart = early.value.start(payload(), earlyEvents)
    const earlyRejected = expect(earlyStart).rejects.toMatchObject({
      code: 'MONITOR_PROTOCOL_ORDER',
    })
    earlyChild.event(1, 'prediction_state', { state: 'aspect_mismatch' })
    await earlyRejected
    expect(earlyEvents.onPredictionState).not.toHaveBeenCalled()
    earlyChild.emit('close', 1, null)

    const child = new FakeChild()
    const monitored = service(child)
    const events = listener()
    const started = monitored.value.start(payload(), events)
    child.event(1, 'ready', { frameWidth: 1200, frameHeight: 1600 })
    await started
    child.event(2, 'learning', {
      status: 'failed',
      reason: 'AUTO_GAME_NOT_FOUND',
      rejectedCount: 0,
    })
    expect(events.onLearning).not.toHaveBeenCalled()
    expect(events.onFatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MONITOR_PROTOCOL_INVALID' }),
    )
    child.emit('close', 1, null)
  })

  it('allows A2 consumers to leave new event callbacks unset until A3', async () => {
    const child = new FakeChild()
    const monitored = service(child)
    const events = listener()
    delete events.onGeometry
    delete events.onLearning
    delete events.onLayoutLearned
    delete events.onPredictionState
    const started = monitored.value.start(payload(), events)
    child.event(1, 'ready', { frameWidth: 1200, frameHeight: 1600 })
    await started
    child.event(2, 'prediction_state', { state: 'active' })
    child.event(3, 'learning', {
      status: 'failed',
      reason: 'LEARN_STRUCTURAL_TRIGGER',
      rejectedCount: 0,
    })
    child.event(4, 'layout_learned', {
      calibrationId: monitorGamePrimaryFixture().profileCalibrationId,
      layout: monitorLearnedLayoutFixture(),
      triggerId: null,
    })
    child.event(5, 'geometry', {
      state: 'no_game',
      frameWidth: 1200,
      frameHeight: 1600,
      gameRect: null,
      gameAspect: null,
      layoutId: null,
    })
    expect(events.onFatal).not.toHaveBeenCalled()
    const stopped = monitored.value.stop()
    child.emit('close', 0, null)
    await stopped
  })

  it('forwards window minimise and restore notifications to the listener', async () => {
    const child = new FakeChild()
    const monitored = service(child)
    const events = { ...listener(), onSourceState: vi.fn() }
    const started = monitored.value.start(payload(), events)
    child.event(1, 'ready', { frameWidth: 1200, frameHeight: 1600 })
    await started
    child.event(2, 'source_state', { minimized: true })
    child.event(3, 'source_state', { minimized: false })
    expect(events.onSourceState.mock.calls).toEqual([
      [{ minimized: true }],
      [{ minimized: false }],
    ])
    expect(events.onFatal).not.toHaveBeenCalled()
    const stopped = monitored.value.stop()
    child.emit('close', 0, null)
    await stopped
  })
})
