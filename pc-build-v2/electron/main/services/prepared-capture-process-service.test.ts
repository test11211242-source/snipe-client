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

describe('PreparedCaptureProcessService', () => {
  it('starts one selected source and freezes the latest validated PNG', async () => {
    const child = new FakeChild()
    const service = new PreparedCaptureProcessService(
      'python.exe',
      'prepared_capture.py',
      { warn: vi.fn() },
      vi.fn(() => child),
      vi.fn().mockResolvedValue(undefined),
    )
    const starting = service.start({ kind: 'window', windowHwnd: '123' })
    expect(child.commands[0]?.metadata).toMatchObject({
      type: 'start',
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
      },
      image,
    )
    await expect(freezing).resolves.toEqual({
      size: { width: 1280, height: 720 },
      png: image,
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
})
