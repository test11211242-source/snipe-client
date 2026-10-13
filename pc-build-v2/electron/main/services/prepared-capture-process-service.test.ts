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
          protocolVersion: 1,
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
      protocolVersion: 1,
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
})
