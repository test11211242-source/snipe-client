import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  BinaryEnvelopeStreamDecoder,
  encodeBinaryEnvelope,
  type BinaryEnvelope,
} from './binary-protocol'
import {
  PreparedCaptureProcessService,
  type PreparedCaptureChild,
} from './prepared-capture-process-service'

class FakeChild extends EventEmitter implements PreparedCaptureChild {
  pid = 4321
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  readonly commands: BinaryEnvelope[] = []
  readonly #decoder = new BinaryEnvelopeStreamDecoder({
    maxMetadataBytes: 64 * 1024,
    maxBinaryBytes: 0,
  })

  constructor() {
    super()
    this.stdin.on('data', (chunk) => {
      this.commands.push(...this.#decoder.push(Buffer.from(chunk)))
    })
  }

  sessionId(): string {
    const metadata = this.commands[0]?.metadata as { sessionId?: unknown } | undefined
    if (typeof metadata?.sessionId !== 'string') throw new Error('Missing session')
    return metadata.sessionId
  }

  event(
    sequence: number,
    type: string,
    payload: unknown,
    binary: Uint8Array = new Uint8Array(),
  ): void {
    this.stdout.write(
      encodeBinaryEnvelope(
        {
          protocolVersion: 2,
          sessionId: this.sessionId(),
          sequence,
          type,
          payload,
        },
        binary,
      ),
    )
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

function png(width: number, height: number): Buffer {
  const image = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
  image.write('IHDR', 12, 'ascii')
  image.writeUInt32BE(width, 16)
  image.writeUInt32BE(height, 20)
  return image
}

const game = {
  rect: { x: 40, y: 24, width: 360, height: 640 },
  aspect: 360 / 640,
  chrome: {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    topEdges: null,
    bottomEdges: null,
    leftEdges: null,
    rightEdges: null,
  },
  frames: 8,
}

const badge = { cx: 0.496, cy: 0.429, width: 0.211, height: 0.147 }
const success = {
  ok: true,
  frameWidth: 1280,
  frameHeight: 720,
  game: { rect: game.rect, aspect: game.aspect, chrome: game.chrome },
  badge,
  regions: {
    trigger: { x: 0.35, y: 0.3, width: 0.3, height: 0.25 },
    nickname: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
    topLeftEvidence: { x: 0.01, y: 0.05, width: 0.4, height: 0.15 },
  },
  trigger: {
    kind: 'vs_edge_orientation',
    algorithm: 'vs-orient-1',
    badge,
    normalizedSize: { width: 96, height: 96 },
    cropMargin: 0.08,
    padding: 4,
    maxShift: 3,
    threshold: 0.5,
    angleQ8Base64: Buffer.alloc(96 * 96).toString('base64'),
    weightQ8Base64: Buffer.alloc(96 * 96, 255).toString('base64'),
    templateHash64: 'a'.repeat(16),
    maskAreaRatio: 0.6,
  },
  confidence: 0.9,
  selfCheck: { minVs: 0.8, maxBefore: 0.1, frames: 12 },
  timings: { onsetMs: 2500, confirmMs: 2700 },
}

async function analyzingService() {
  const child = new FakeChild()
  const treeKill = vi.fn().mockResolvedValue(undefined)
  const service = new PreparedCaptureProcessService(
    'python.exe',
    'prepared_capture.py',
    { warn: vi.fn() },
    vi.fn(() => child),
    treeKill,
  )
  const starting = service.start({ kind: 'window', windowHwnd: '123' })
  child.event(1, 'ready', { frameSequence: 1, width: 1280, height: 720 })
  const { sessionId } = await starting
  return { child, service, sessionId, treeKill }
}

describe('PreparedCaptureProcessService', () => {
  it('settles readiness when cancelled before the first frame and allows another source', async () => {
    const child = new FakeChild()
    const nextChild = new FakeChild()
    const spawn = vi.fn().mockReturnValueOnce(child).mockReturnValueOnce(nextChild)
    const service = new PreparedCaptureProcessService(
      'python.exe',
      'prepared_capture.py',
      { warn: vi.fn() },
      spawn,
    )
    const starting = service.start({ kind: 'window', windowHwnd: '123' })
    const rejected = expect(starting).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_CANCELLED',
    })
    const stopping = service.stop()
    child.emit('close', 0, null)
    await rejected
    await stopping
    const next = service.start({ kind: 'window', windowHwnd: '456' })
    nextChild.event(1, 'ready', { frameSequence: 1, width: 1280, height: 720 })
    await expect(next).resolves.toMatchObject({ size: { width: 1280, height: 720 } })
    const cleanup = service.stop()
    nextChild.emit('close', 0, null)
    await cleanup
  })
  it('starts one selected source and freezes the latest validated PNG', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const service = new PreparedCaptureProcessService(
      'python.exe',
      'prepared_capture.py',
      { warn: vi.fn() },
      spawn,
      vi.fn().mockResolvedValue(undefined),
    )
    const starting = service.start({ kind: 'window', windowHwnd: '123' })
    expect(spawn).toHaveBeenCalledWith(
      'python.exe',
      ['-B', 'prepared_capture.py'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    )
    expect(child.commands[0]?.metadata).toMatchObject({
      type: 'start',
      protocolVersion: 2,
      selector: { kind: 'window', windowHwnd: '123' },
    })
    child.event(1, 'ready', {
      frameSequence: 3,
      width: 1280,
      height: 720,
    })
    const prepared = await starting

    const freezing = service.freeze(prepared.sessionId)
    expect(child.commands[1]?.metadata).toMatchObject({ type: 'freeze' })
    const image = png(1280, 720)
    child.event(
      2,
      'frozen',
      {
        frameSequence: 4,
        width: 1280,
        height: 720,
        mimeType: 'image/png',
        byteLength: image.byteLength,
        game,
      },
      image,
    )
    await expect(freezing).resolves.toEqual({
      size: { width: 1280, height: 720 },
      png: image,
      game,
    })
    child.emit('close', 0, null)
  })

  it('rejects stale freezes and stops a prepared child explicitly', async () => {
    const child = new FakeChild()
    const service = new PreparedCaptureProcessService(
      'python.exe',
      'prepared_capture.py',
      { warn: vi.fn() },
      vi.fn(() => child),
      vi.fn().mockResolvedValue(undefined),
    )
    const starting = service.start({
      kind: 'display',
      electronDisplayId: '1',
      displayDeviceName: '\\\\.\\DISPLAY1',
    })
    child.event(1, 'ready', { frameSequence: 1, width: 1920, height: 1080 })
    const prepared = await starting
    await expect(
      service.freeze('00000000-0000-4000-8000-000000000099'),
    ).rejects.toMatchObject({ code: 'CAPTURE_PREPARATION_STALE' })

    const stopping = service.stop()
    expect(child.commands[1]?.metadata).toMatchObject({
      sessionId: prepared.sessionId,
      type: 'stop',
    })
    child.event(2, 'stopped', {})
    child.emit('close', 0, null)
    await expect(stopping).resolves.toBeUndefined()
  })

  it.each(['too_small', 'aspect_out_of_range', 'unstable', 'insufficient_frames'])(
    'preserves a genuine no-game outcome (%s) for the setup owner',
    async (reason) => {
      const child = new FakeChild()
      const service = new PreparedCaptureProcessService(
        'python.exe',
        'prepared_capture.py',
        { warn: vi.fn() },
        vi.fn(() => child),
        vi.fn().mockResolvedValue(undefined),
      )
      const starting = service.start({ kind: 'window', windowHwnd: '123' })
      child.event(1, 'ready', { frameSequence: 1, width: 1280, height: 720 })
      const prepared = await starting
      const freezing = service.freeze(prepared.sessionId)
      const image = png(1280, 720)
      child.event(
        2,
        'frozen',
        {
          frameSequence: 2,
          width: 1280,
          height: 720,
          mimeType: 'image/png',
          byteLength: image.byteLength,
          game: { rect: null, reason },
        },
        image,
      )
      await expect(freezing).resolves.toMatchObject({ game: { rect: null, reason } })
      child.emit('close', 0, null)
    },
  )

  it.each<[string, Record<string, unknown>]>([
    ['missing game', { game: undefined }],
    ['null game', { game: null }],
    ['unknown payload field', { extra: true }],
    ['unknown game field', { game: { ...game, extra: true } }],
    ['unknown failure reason', { game: { rect: null, reason: 'not_found' } }],
    ['game outside frame', { game: { ...game, rect: { ...game.rect, x: 1000 } } }],
    ['game below frame', { game: { ...game, rect: { ...game.rect, y: 100 } } }],
    ['aspect mismatch', { game: { ...game, aspect: game.aspect + 0.01 } }],
    ['PNG byte-length mismatch', { byteLength: 25 }],
    ['PNG dimensions mismatch', { width: 1279 }],
  ])('rejects frozen %s', async (_name, fields) => {
    const child = new FakeChild()
    const service = new PreparedCaptureProcessService(
      'python.exe',
      'prepared_capture.py',
      { warn: vi.fn() },
      vi.fn(() => child),
      vi.fn().mockResolvedValue(undefined),
    )
    const starting = service.start({ kind: 'window', windowHwnd: '123' })
    child.event(1, 'ready', { frameSequence: 1, width: 1280, height: 720 })
    const prepared = await starting
    const freezing = service.freeze(prepared.sessionId)
    const rejected = expect(freezing).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_PROTOCOL_INVALID',
    })
    const image = png(1280, 720)
    child.event(
      2,
      'frozen',
      {
        frameSequence: 2,
        width: 1280,
        height: 720,
        mimeType: 'image/png',
        byteLength: image.byteLength,
        game,
        ...fields,
      },
      image,
    )
    await rejected
    child.emit('close', 0, null)
  })

  it('accepts bounded chrome templates larger than the old 64 KiB metadata cap', async () => {
    const child = new FakeChild()
    const service = new PreparedCaptureProcessService(
      'python.exe',
      'prepared_capture.py',
      { warn: vi.fn() },
      vi.fn(() => child),
      vi.fn().mockResolvedValue(undefined),
    )
    const starting = service.start({ kind: 'window', windowHwnd: '123' })
    child.event(1, 'ready', { frameSequence: 1, width: 440, height: 1148 })
    const prepared = await starting
    const strip = {
      length: 256 as const,
      thickness: 71,
      angleQ8Base64: Buffer.alloc(256 * 71).toString('base64'),
      weightQ8Base64: Buffer.alloc(256 * 71, 255).toString('base64'),
    }
    const largeGame = {
      ...game,
      rect: { x: 40, y: 124, width: 360, height: 900 },
      aspect: 360 / 900,
      chrome: {
        ...game.chrome,
        top: 100,
        bottom: 100,
        topEdges: strip,
        bottomEdges: strip,
      },
    }
    expect(Buffer.byteLength(JSON.stringify(largeGame))).toBeGreaterThan(64 * 1024)
    const freezing = service.freeze(prepared.sessionId)
    const image = png(440, 1148)
    child.event(
      2,
      'frozen',
      {
        frameSequence: 2,
        width: 440,
        height: 1148,
        mimeType: 'image/png',
        byteLength: image.byteLength,
        game: largeGame,
      },
      image,
    )
    await expect(freezing).resolves.toMatchObject({ game: largeGame })
    child.emit('close', 0, null)
  })

  it('streams strict progress and bounded JPEG preview, preserving the confirmation frame for retry and freeze', async () => {
    const { child, service, sessionId } = await analyzingService()
    const onProgress = vi.fn()
    const onPreview = vi.fn()
    const analysis = service.analyze(sessionId, onProgress, onPreview)
    expect(child.commands.at(-1)?.metadata).toEqual({
      protocolVersion: 2,
      sessionId,
      type: 'analyze',
      deadlineMs: 60_000,
      targetFps: 10,
    })
    const progress = {
      phase: 'waiting_vs',
      elapsedMs: 1000,
      game: { rect: game.rect, aspect: game.aspect },
      framesAnalyzed: 10,
    }
    child.event(2, 'analysis_progress', progress)
    // Minimal bounded JPEG header with a baseline SOF carrying the real dimensions.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 100, 0, 200, 1, 0xff, 0xd9,
    ])
    child.event(
      3,
      'analysis_preview',
      {
        width: 200,
        height: 100,
        mimeType: 'image/jpeg',
        byteLength: jpeg.byteLength,
      },
      jpeg,
    )
    expect(onProgress).toHaveBeenCalledWith(progress)
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ bytes: jpeg }))
    const image = png(1280, 720)
    child.event(4, 'analysis_result', success, image)
    await expect(analysis).resolves.toEqual({
      result: success,
      frame: { size: { width: 1280, height: 720 }, png: image, game },
    })
    expect(service.isAlive(sessionId)).toBe(true)
    const retry = service.analyze(sessionId, vi.fn(), vi.fn())
    child.event(5, 'analysis_result', { ok: false, code: 'AUTO_VS_TIMEOUT' })
    await expect(retry).resolves.toEqual({
      result: { ok: false, code: 'AUTO_VS_TIMEOUT' },
      frame: null,
    })
    const freeze = service.freeze(sessionId)
    child.event(
      6,
      'frozen',
      {
        frameSequence: 99,
        width: 1280,
        height: 720,
        mimeType: 'image/png',
        byteLength: image.byteLength,
        game,
      },
      image,
    )
    await expect(freeze).resolves.toMatchObject({ png: image })
    child.emit('close', 0, null)
  })

  it('fences cancellation and retry using the joined-worker acknowledgement', async () => {
    const { child, service, sessionId } = await analyzingService()
    const first = service.analyze(sessionId, vi.fn(), vi.fn())
    const rejected = expect(first).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_CANCELLED',
    })
    const cancelling = service.cancelAnalysis(sessionId)
    expect(child.commands.at(-1)?.metadata).toMatchObject({ type: 'analyze_cancel' })
    const onProgress = vi.fn()
    const retry = service.analyze(sessionId, onProgress, vi.fn())
    child.event(2, 'analysis_result', success, png(1280, 720))
    expect(child.commands.at(-1)?.metadata).toMatchObject({ type: 'analyze_cancel' })
    child.event(3, 'analysis_cancelled', {})
    await cancelling
    await rejected
    expect(child.commands.at(-1)?.metadata).toMatchObject({ type: 'analyze' })
    expect(onProgress).not.toHaveBeenCalled()
    child.event(4, 'analysis_result', { ok: false, code: 'AUTO_GAME_NOT_FOUND' })
    await expect(retry).resolves.toMatchObject({
      result: { code: 'AUTO_GAME_NOT_FOUND' },
    })
    const stop = service.stop(sessionId)
    child.emit('close', 0, null)
    await stop
  })

  it('ignores every analysis event already in flight while stopping cleanly', async () => {
    const { child, service, sessionId, treeKill } = await analyzingService()
    const onProgress = vi.fn()
    const onPreview = vi.fn()
    const analysis = service.analyze(sessionId, onProgress, onPreview)
    const rejected = expect(analysis).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_CANCELLED',
    })
    const stopping = service.stop(sessionId)
    child.event(2, 'analysis_progress', {
      phase: 'waiting_vs',
      elapsedMs: 1000,
      game: { rect: game.rect, aspect: game.aspect },
      framesAnalyzed: 10,
    })
    child.event(3, 'analysis_preview', {}, Buffer.from('discarded preview'))
    child.event(4, 'analysis_result', success, png(1280, 720))
    child.event(5, 'analysis_cancelled', {})
    expect(onProgress).not.toHaveBeenCalled()
    expect(onPreview).not.toHaveBeenCalled()
    expect(treeKill).not.toHaveBeenCalled()
    expect(child.commands.at(-1)?.metadata).toMatchObject({ type: 'stop' })
    child.event(6, 'stopped', {})
    child.emit('close', 0, null)
    await rejected
    await expect(stopping).resolves.toBeUndefined()
    expect(treeKill).not.toHaveBeenCalled()
  })

  it('kills analysis only at deadline plus five seconds and resolves the internal timeout', async () => {
    vi.useFakeTimers()
    try {
      const { child, service, sessionId, treeKill } = await analyzingService()
      const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
      await vi.advanceTimersByTimeAsync(64_999)
      expect(treeKill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await expect(analysis).resolves.toMatchObject({
        result: { ok: false, code: 'AUTO_INTERNAL_TIMEOUT' },
        frame: null,
      })
      expect(treeKill).toHaveBeenCalledWith(child.pid)
      expect(service.isAlive(sessionId)).toBe(false)
      child.emit('close', null, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['fatal', 'close', 'error'] as const)(
    'maps %s during analysis without hanging',
    async (event) => {
      const { child, service, sessionId } = await analyzingService()
      const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
      if (event === 'fatal')
        child.event(2, 'fatal', { code: 'CAPTURE_SOURCE_STALE', message: 'Source gone' })
      if (event === 'close') child.emit('close', 1, null)
      if (event === 'error') child.emit('error', new Error('Process failed'))
      await expect(analysis).resolves.toMatchObject({
        result: { code: event === 'fatal' ? 'AUTO_SOURCE_LOST' : 'AUTO_INTERNAL_ERROR' },
      })
      child.emit('close', 1, null)
    },
  )

  it.each<[string, unknown, Buffer]>([
    ['unknown field', { ...success, extra: true }, png(1280, 720)],
    ['missing PNG', success, Buffer.alloc(0)],
    ['PNG width mismatch', success, png(1279, 720)],
    [
      'oversized frame',
      { ...success, frameWidth: 16384, frameHeight: 16384 },
      png(16384, 16384),
    ],
    [
      'game exceeds frame',
      { ...success, game: { ...success.game, rect: { ...game.rect, x: 1000 } } },
      png(1280, 720),
    ],
    ['badge mismatch', { ...success, badge: { ...badge, cx: 0.5 } }, png(1280, 720)],
    ['failure code', { ok: false, code: 'AUTO_UNKNOWN' }, Buffer.alloc(0)],
    [
      'unpaired dimensions',
      { ok: false, code: 'AUTO_VS_TIMEOUT', frameWidth: 1280 },
      Buffer.alloc(0),
    ],
  ])('rejects malformed analysis result: %s', async (_name, payload, binary) => {
    const { child, service, sessionId, treeKill } = await analyzingService()
    const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
    child.event(2, 'analysis_result', payload, binary)
    await expect(analysis).resolves.toMatchObject({
      result: { code: 'AUTO_INTERNAL_ERROR' },
      frame: null,
    })
    expect(treeKill).toHaveBeenCalledOnce()
    child.emit('close', 1, null)
  })

  it.each<[unknown, Buffer]>([
    [{ width: 641, height: 1, mimeType: 'image/jpeg', byteLength: 14 }, Buffer.alloc(14)],
    [
      { width: 200, height: 100, mimeType: 'image/jpeg', byteLength: 13 },
      Buffer.alloc(14),
    ],
    [
      { width: 200, height: 100, mimeType: 'image/jpeg', byteLength: 14, bytes: [] },
      Buffer.alloc(14),
    ],
    [
      { width: 200, height: 100, mimeType: 'image/jpeg', byteLength: 14 },
      Buffer.alloc(14),
    ],
  ])('rejects malformed JPEG preview', async (payload, binary) => {
    const { child, service, sessionId } = await analyzingService()
    const onPreview = vi.fn()
    const analysis = service.analyze(sessionId, vi.fn(), onPreview)
    child.event(2, 'analysis_preview', payload, binary)
    await expect(analysis).resolves.toMatchObject({
      result: { code: 'AUTO_INTERNAL_ERROR' },
    })
    expect(onPreview).not.toHaveBeenCalled()
    child.emit('close', 1, null)
  })

  it('rejects progress moving backwards and stale process operations', async () => {
    const { child, service, sessionId } = await analyzingService()
    expect(service.isAlive('stale')).toBe(false)
    await service.stop('stale')
    expect(child.commands).toHaveLength(1)
    const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
    child.event(2, 'analysis_progress', {
      phase: 'locating_game',
      elapsedMs: 500,
      game: null,
      framesAnalyzed: 5,
    })
    child.event(3, 'analysis_progress', {
      phase: 'locating_game',
      elapsedMs: 499,
      game: null,
      framesAnalyzed: 5,
    })
    await expect(analysis).resolves.toMatchObject({
      result: { code: 'AUTO_INTERNAL_ERROR' },
    })
    child.emit('close', 1, null)
  })

  it('kills a stuck cancellation fence instead of allowing a retry to consume stale output', async () => {
    vi.useFakeTimers()
    try {
      const { child, service, sessionId, treeKill } = await analyzingService()
      const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
      const cancelled = expect(analysis).rejects.toMatchObject({
        code: 'CAPTURE_PREPARATION_CANCELLED',
      })
      const cancellation = service.cancelAnalysis(sessionId)
      const rejected = expect(cancellation).rejects.toMatchObject({
        code: 'AUTO_INTERNAL_TIMEOUT',
      })
      await vi.advanceTimersByTimeAsync(5000)
      await cancelled
      await rejected
      expect(treeKill).toHaveBeenCalledOnce()
      expect(service.isAlive(sessionId)).toBe(false)
      child.emit('close', null, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels via AbortSignal and completes the acknowledgement before freeze', async () => {
    const { child, service, sessionId } = await analyzingService()
    const controller = new AbortController()
    const analysis = service.analyze(sessionId, vi.fn(), vi.fn(), controller.signal)
    const rejected = expect(analysis).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_CANCELLED',
    })
    controller.abort()
    const cancellation = service.cancelAnalysis(sessionId)
    child.event(2, 'analysis_cancelled', {})
    await cancellation
    await rejected
    const frame = png(1280, 720)
    const frozen = service.freeze(sessionId)
    child.event(
      3,
      'frozen',
      {
        frameSequence: 5,
        width: 1280,
        height: 720,
        mimeType: 'image/png',
        byteLength: frame.byteLength,
        game,
      },
      frame,
    )
    await expect(frozen).resolves.toMatchObject({ png: frame })
    child.emit('close', 0, null)
  })

  it('marks a wire source-loss result dead even when the worker has not closed yet', async () => {
    const { child, service, sessionId, treeKill } = await analyzingService()
    const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
    child.event(2, 'analysis_result', { ok: false, code: 'AUTO_SOURCE_LOST' })
    await expect(analysis).resolves.toMatchObject({
      result: { code: 'AUTO_SOURCE_LOST' },
    })
    expect(service.isAlive(sessionId)).toBe(false)
    expect(treeKill).toHaveBeenCalledOnce()
    child.emit('close', 1, null)
  })

  it.each([
    ['CAPTURE_SOURCE_STALE', 'AUTO_SOURCE_LOST'],
    ['PREPARED_CAPTURE_FAILED', 'AUTO_INTERNAL_ERROR'],
  ])(
    'classifies fatal %s without claiming unrelated process failures lost the source',
    async (code, expected) => {
      const { child, service, sessionId, treeKill } = await analyzingService()
      const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
      child.event(2, 'fatal', { code, message: 'private fatal detail' })
      await expect(analysis).resolves.toMatchObject({
        result: { ok: false, code: expected },
        frame: null,
      })
      expect(service.isAlive(sessionId)).toBe(false)
      expect(treeKill).toHaveBeenCalledOnce()
      child.emit('close', 1, null)
    },
  )

  it('rejects protocol-1 prepared events rather than accepting mixed subprocess versions', async () => {
    const { child, service, sessionId } = await analyzingService()
    const analysis = service.analyze(sessionId, vi.fn(), vi.fn())
    child.stdout.write(
      encodeBinaryEnvelope({
        protocolVersion: 1,
        sessionId,
        sequence: 2,
        type: 'analysis_result',
        payload: { ok: false, code: 'AUTO_VS_TIMEOUT' },
      }),
    )
    await expect(analysis).resolves.toMatchObject({
      result: { code: 'AUTO_INTERNAL_ERROR' },
    })
    child.emit('close', 1, null)
  })
})
