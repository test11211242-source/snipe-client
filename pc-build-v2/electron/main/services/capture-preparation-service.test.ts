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
})
