import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MonitorStartPayload } from '../../../shared/contracts/monitor-protocol'
import {
  MonitorProcessService,
  type MonitorChild,
  type MonitorProcessListener,
} from './monitor-process-service'

function payload(): MonitorStartPayload {
  return {
    selector: { kind: 'window', windowHwnd: '123' },
    configuredFrameSize: { width: 1920, height: 1080 },
    regions: {
      trigger: { x: 0, y: 0, width: 0.2, height: 0.2 },
      normal: { x: 0, y: 0, width: 0.5, height: 0.5 },
      precise: { x: 0, y: 0, width: 1, height: 1 },
    },
    triggerProfile: {
      schemaVersion: 2,
      analyzer: { name: 'cr-tools-trigger-analyzer', version: '1.0.0' },
      hashAlgorithm: 'ahash64-bitwise-v1',
      ahash64: '0123456789abcdef',
      innerRect: { x: 0, y: 0, width: 1, height: 1 },
      featureMode: 'ncc',
      keypointsCount: 0,
      normalizedTemplateSize: { width: 128, height: 128 },
      templateGrayBase64: 'AAAA',
      hashMaxDistance: 18,
      orbDistanceThreshold: 55,
      orbMinGoodMatches: 10,
      nccMinScore: 0.72,
    },
    searchMode: 'fast',
    captureDelaySeconds: 0,
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
        protocolVersion: 2,
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
    onFatal: vi.fn(),
    onExit: vi.fn(),
  }
}

function service(child: FakeChild, treeKill = vi.fn().mockResolvedValue(undefined)) {
  return {
    treeKill,
    value: new MonitorProcessService(
      'python.exe',
      'monitor_engine.py',
      { info: vi.fn(), warn: vi.fn() },
      vi.fn(() => child),
      treeKill,
    ),
  }
}

afterEach(() => vi.useRealTimers())

describe('MonitorProcessService', () => {
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
      ['monitor_engine.py'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    )
    expect(child.written.trim().split('\n')).toHaveLength(1)
    expect(child.command()['protocolVersion']).toBe(2)
    child.event(1, 'ready', { frameWidth: 1920, frameHeight: 1080 })
    await expect(started).resolves.toBe(child.command()['sessionId'])
    const stopped = monitor.stop()
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
    await vi.advanceTimersByTimeAsync(8_000)
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
    child.event(2, 'triggered', {
      timestamp: '2026-07-12T12:00:00.000Z',
    })
    expect(processListener.onTriggered).toHaveBeenCalledWith('2026-07-12T12:00:00.000Z')
    child.event(3, 'action', {
      timestamp: '2026-07-12T12:00:00.000Z',
      width: 20,
      height: 10,
      byteLength: image.byteLength,
      imageBase64: image.toString('base64'),
    })
    expect(processListener.onAction).toHaveBeenCalledWith(
      expect.objectContaining({ width: 20, height: 10, image }),
    )
    child.event(4, 'prediction_result', {
      timestamp: '2026-07-12T12:00:01.000Z',
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
})
