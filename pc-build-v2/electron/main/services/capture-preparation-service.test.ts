import { describe, expect, it, vi } from 'vitest'

import type { ResolvedCaptureSource } from '../domain/capture-source'
import { CapturePreparationService } from './capture-preparation-service'

const source: ResolvedCaptureSource = {
  view: {
    sourceKey: 'a'.repeat(32),
    revision: 'b'.repeat(32),
    kind: 'window',
    label: 'Game',
    detail: null,
    captureSupported: true,
    unavailableReason: null,
    preview: null,
  },
  selector: { kind: 'window', windowHwnd: '123' },
  preference: {
    kind: 'window',
    label: 'Game',
    titleHint: 'Game',
    executableLabel: null,
  },
}

describe('CapturePreparationService', () => {
  it('interrupts an in-flight readiness wait when the user changes source', async () => {
    let rejectFirst!: (error: Error) => void
    const pending = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject
    })
    const process = {
      start: vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockResolvedValue({ sessionId: 'next' }),
      stop: vi.fn().mockImplementation(() => {
        if (process.start.mock.calls.length === 1) rejectFirst(new Error('cancelled'))
        return Promise.resolve()
      }),
    }
    const service = new CapturePreparationService(
      { resolve: vi.fn().mockResolvedValue(source) } as never,
      process as never,
    )
    const first = service.prepare('a'.repeat(32), 'b'.repeat(32))
    const rejected = expect(first).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(process.start).toHaveBeenCalledOnce())
    const second = service.prepare('c'.repeat(32), 'b'.repeat(32))
    await rejected
    await expect(second).resolves.toMatchObject({ sourceKey: 'c'.repeat(32) })
    expect(process.start).toHaveBeenCalledTimes(2)
  })
  it('binds an opaque preparation to its resolved source and consumes it once', async () => {
    const process = {
      start: vi.fn().mockResolvedValue({
        sessionId: '00000000-0000-4000-8000-000000000010',
        size: { width: 1280, height: 720 },
      }),
      freeze: vi.fn().mockResolvedValue({
        size: { width: 1280, height: 720 },
        png: Buffer.from('png'),
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const service = new CapturePreparationService(
      { resolve: vi.fn().mockResolvedValue(source) } as never,
      process as never,
    )
    const prepared = await service.prepare(source.view.sourceKey, source.view.revision)
    expect(process.start).toHaveBeenCalledWith(source.selector)
    await expect(service.freeze(prepared.preparationId)).resolves.toEqual({
      source,
      frame: { size: { width: 1280, height: 720 }, png: Buffer.from('png') },
    })
    await expect(service.freeze(prepared.preparationId)).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_STALE',
    })
  })

  it('fences a superseded preparation before spawning it', async () => {
    const process = {
      start: vi.fn().mockResolvedValue({
        sessionId: '00000000-0000-4000-8000-000000000010',
        size: { width: 10, height: 10 },
      }),
      freeze: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const registry = { resolve: vi.fn().mockResolvedValue(source) }
    const service = new CapturePreparationService(registry as never, process as never)
    const first = service.prepare('a'.repeat(32), 'b'.repeat(32))
    const second = service.prepare('c'.repeat(32), 'd'.repeat(32))

    await expect(first).rejects.toMatchObject({ code: 'CAPTURE_PREPARATION_CANCELLED' })
    await expect(second).resolves.toMatchObject({
      sourceKey: 'c'.repeat(32),
      revision: 'd'.repeat(32),
    })
    expect(process.start).toHaveBeenCalledTimes(1)
  })

  it('transfers live ownership once and fences old release and preparation shutdown', async () => {
    const process = {
      start: vi
        .fn()
        .mockResolvedValue({ sessionId: 'live', size: { width: 1280, height: 720 } }),
      stop: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn().mockReturnValue(true),
      getSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
      analyze: vi.fn().mockResolvedValue({
        result: { ok: false, code: 'AUTO_VS_TIMEOUT' },
        frame: null,
      }),
      cancelAnalysis: vi.fn().mockResolvedValue(undefined),
      freeze: vi.fn().mockResolvedValue({
        size: { width: 1280, height: 720 },
        png: Buffer.from('frame'),
      }),
    }
    const service = new CapturePreparationService(
      { resolve: vi.fn().mockResolvedValue(source) } as never,
      process as never,
    )
    const prepared = await service.prepare(source.view.sourceKey, source.view.revision)
    const { capture, source: transferred } = await service.takeLive(
      prepared.preparationId,
    )
    expect(transferred).toEqual(source)
    expect(capture.isAlive()).toBe(true)
    expect(capture.getSize()).toEqual({ width: 1280, height: 720 })
    await expect(service.takeLive(prepared.preparationId)).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_STALE',
    })
    await expect(service.release(prepared.sourceKey, prepared.revision)).resolves.toBe(
      false,
    )
    await service.stop()
    expect(process.stop).toHaveBeenCalledTimes(1) // Initial prepare only.
    await expect(
      service.prepare(prepared.sourceKey, prepared.revision),
    ).rejects.toMatchObject({ code: 'CAPTURE_PREPARATION_OWNED' })
    const onProgress = vi.fn()
    const onPreview = vi.fn()
    await capture.analyze(onProgress, onPreview)
    expect(process.analyze).toHaveBeenCalledWith('live', onProgress, onPreview, undefined)
    await capture.freeze()
    expect(process.cancelAnalysis).toHaveBeenCalledWith('live')
    expect(process.freeze).toHaveBeenCalledWith('live', undefined)
    expect(capture.isAlive()).toBe(false)
    expect(capture.getSize()).toBeNull()
    await capture.stop()
    expect(process.stop).toHaveBeenCalledTimes(1)
    await expect(capture.freeze()).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_STALE',
    })
  })

  it('stops a transferred capture by its session id and never touches its successor', async () => {
    const process = {
      start: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: 'first' })
        .mockResolvedValueOnce({ sessionId: 'second' }),
      stop: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn().mockReturnValue(true),
      cancelAnalysis: vi.fn().mockResolvedValue(undefined),
    }
    const service = new CapturePreparationService(
      { resolve: vi.fn().mockResolvedValue(source) } as never,
      process as never,
    )
    const first = await service.prepare(source.view.sourceKey, source.view.revision)
    const { capture } = await service.takeLive(first.preparationId)
    await capture.stop()
    expect(process.stop).toHaveBeenLastCalledWith('first')
    expect(capture.isAlive()).toBe(false)
    const next = await service.prepare(source.view.sourceKey, source.view.revision)
    const calls = process.stop.mock.calls.length
    await capture.stop()
    await capture.cancelAnalysis()
    expect(process.stop).toHaveBeenCalledTimes(calls)
    expect(process.cancelAnalysis).not.toHaveBeenCalled()
    await expect(service.takeLive(first.preparationId)).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_STALE',
    })
    await expect(service.takeLive(next.preparationId)).resolves.toMatchObject({ source })
  })

  it('rejects a lost prepared source without transferring it', async () => {
    const process = {
      start: vi.fn().mockResolvedValue({ sessionId: 'lost' }),
      stop: vi.fn().mockResolvedValue(undefined),
      isAlive: vi.fn().mockReturnValue(false),
    }
    const service = new CapturePreparationService(
      { resolve: vi.fn().mockResolvedValue(source) } as never,
      process as never,
    )
    const prepared = await service.prepare(source.view.sourceKey, source.view.revision)
    await expect(service.takeLive(prepared.preparationId)).rejects.toMatchObject({
      code: 'CAPTURE_PREPARATION_STALE',
    })
    await expect(service.release(prepared.sourceKey, prepared.revision)).resolves.toBe(
      true,
    )
    expect(process.stop).toHaveBeenCalledTimes(2)
  })
})
