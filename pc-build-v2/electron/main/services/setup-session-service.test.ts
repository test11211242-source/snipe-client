import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { ApiClient } from './api-client'
import type { AuthSession } from './auth-session'
import type { CaptureService } from './capture-service'
import { SetupSessionService, buildLegacyProjection } from './setup-session-service'
import { LegacyOcrRegionsSchema } from '../../../shared/models/setup'

const profile = {
  schemaVersion: 2 as const,
  analyzer: { name: 'cr-tools-trigger-analyzer' as const, version: '1.0.0' },
  hashAlgorithm: 'ahash64-bitwise-v1' as const,
  ahash64: '0123456789abcdef',
  innerRect: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
  featureMode: 'ncc' as const,
  keypointsCount: 3,
  normalizedTemplateSize: { width: 128, height: 128 },
  templateGrayBase64: 'AAAA',
  hashMaxDistance: 18,
  orbDistanceThreshold: 55,
  orbMinGoodMatches: 10,
  nccMinScore: 0.72,
}
const frame = { size: { width: 1000, height: 500 }, png: Buffer.from('png') }
const preference = {
  kind: 'window' as const,
  label: 'Game',
  titleHint: 'Game',
  executableLabel: null,
}
const selector = { kind: 'window' as const, windowHwnd: '9007199254740993' }

function harness(remoteOk = true) {
  const capture = {
    capture: vi.fn().mockResolvedValue(frame),
    analyze: vi.fn().mockResolvedValue(profile),
  }
  const repository = {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  }
  const apiRequests: unknown[] = []
  const api = {
    request: vi.fn((request: unknown) => {
      apiRequests.push(request)
      return Promise.resolve(
        remoteOk
          ? { ok: true as const, status: 200, data: { success: true } }
          : {
              ok: false as const,
              error: {
                code: 'NETWORK_UNAVAILABLE' as const,
                message: 'offline',
                retryable: true,
                status: null,
              },
            },
      )
    }),
  }
  const auth = {
    getView: () => ({ user: { id: '42' } }),
    getAccessToken: vi.fn().mockResolvedValue('secret'),
  }
  const service = new SetupSessionService(
    capture as unknown as CaptureService,
    repository as unknown as CaptureConfigurationRepository,
    api as unknown as ApiClient,
    auth as unknown as AuthSession,
    () => new Date('2026-07-12T12:00:00.000Z'),
  )
  return { service, capture, repository, apiRequests }
}

async function readyForCommit(service: SetupSessionService) {
  let view = await service.start(selector, preference)
  for (const region of ['trigger', 'normal', 'precise'] as const) {
    view = service.setRegion(view.sessionId, view.generation, region, {
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.5,
    })
  }
  view = await service.analyzeTrigger(view.sessionId, view.generation)
  return service.review(view.sessionId, view.generation)
}

describe('SetupSessionService', () => {
  it('rejects stale generations and invalid rectangles', async () => {
    const { service } = harness()
    const view = await service.start(selector, preference)
    expect(() =>
      service.setRegion(view.sessionId, view.generation - 1, 'trigger', {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    ).toThrow(/stale/)
    expect(() =>
      service.setRegion(view.sessionId, view.generation, 'trigger', {
        x: 0.8,
        y: 0,
        width: 0.3,
        height: 1,
      }),
    ).toThrow()
  })

  it('cancels an analyzer and fences its late completion', async () => {
    const { service, capture } = harness()
    let release: ((value: typeof profile) => void) | undefined
    capture.analyze.mockImplementation(
      () =>
        new Promise<typeof profile>((resolve) => {
          release = resolve
        }),
    )
    let view = await service.start(selector, preference)
    view = service.setRegion(view.sessionId, view.generation, 'trigger', {
      x: 0.1,
      y: 0.1,
      width: 0.5,
      height: 0.5,
    })
    const analyzing = service.analyzeTrigger(view.sessionId, view.generation)
    const cancelled = service.cancel(view.sessionId, view.generation)
    release?.(profile)
    await expect(analyzing).resolves.toMatchObject({ state: 'CANCELLED' })
    expect(cancelled.state).toBe('CANCELLED')
  })

  it('keeps local configuration unchanged when the remote POST fails', async () => {
    const { service, repository } = harness(false)
    const view = await readyForCommit(service)
    await expect(service.commit(view.sessionId, view.generation)).resolves.toMatchObject({
      state: 'REVIEW',
      error: { code: 'NETWORK_UNAVAILABLE' },
    })
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('posts the exact legacy projection before an atomic per-user commit', async () => {
    const { service, repository, apiRequests } = harness()
    const view = await readyForCommit(service)
    await expect(service.commit(view.sessionId, view.generation)).resolves.toMatchObject({
      state: 'COMMITTED',
    })
    const posted = z
      .object({
        method: z.literal('POST'),
        path: z.literal('/api/user/me/ocr-regions'),
        accessToken: z.literal('secret'),
        body: LegacyOcrRegionsSchema,
      })
      .loose()
      .parse(apiRequests[0])
    expect(posted.body).toMatchObject({
      schema_version: 2,
      trigger_area: {
        x: 100,
        y: 50,
        width: 500,
        height: 250,
        trigger_profile: {
          schema_version: 2,
          thumbnail_hash: '0123456789abcdef',
          hash_algorithm: 'ahash64-bitwise-v1',
        },
      },
      normal_data_area: { x: 100, y: 50 },
      precise_data_area: { x: 100, y: 50 },
      screen_resolution: { width: 1000, height: 500 },
    })
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '42', revision: 1, source: preference }),
    )
  })

  it('reports partial remote result setup and does not activate local configuration', async () => {
    const capture = {
      capture: vi.fn().mockResolvedValue(frame),
      analyze: vi.fn().mockResolvedValue(profile),
    }
    const resultRepository = { load: vi.fn().mockResolvedValue(null), save: vi.fn() }
    const resultPaths: string[] = []
    const authenticatedApi = {
      request: vi.fn((request: { path: string }) => {
        resultPaths.push(request.path)
        return Promise.resolve(
          resultPaths.length === 1
            ? { ok: true, status: 200, data: { success: true } }
            : { ok: false, error: { code: 'NETWORK_UNAVAILABLE', message: 'offline' } },
        )
      }),
    }
    const service = new SetupSessionService(
      capture as never,
      { load: vi.fn(), save: vi.fn() } as never,
      { request: vi.fn() } as never,
      { getView: () => ({ user: { id: '42' } }) } as never,
      () => new Date('2026-07-12T12:00:00.000Z'),
      resultRepository as never,
      authenticatedApi as never,
    )
    let view = await service.start(selector, preference, 'predictionResult')
    view = service.setRegion(view.sessionId, view.generation, 'resultTrigger', {
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    })
    view = service.setRegion(view.sessionId, view.generation, 'resultData', {
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    })
    view = await service.analyzeTrigger(view.sessionId, view.generation)
    view = service.review(view.sessionId, view.generation)
    const result = await service.commit(view.sessionId, view.generation)
    expect(result).toMatchObject({
      state: 'REVIEW',
      error: { code: 'RESULT_SETUP_PARTIAL_REMOTE' },
    })
    expect(resultPaths).toEqual([
      '/api/streamer/result-trigger-area',
      '/api/streamer/result-data-area',
    ])
    expect(resultRepository.save).not.toHaveBeenCalled()
  })

  it('keeps result configuration inactive when local atomic commit fails after both remote writes', async () => {
    const resultRepository = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(new Error('disk full')),
    }
    const authenticatedApi = {
      request: vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, data: { success: true } }),
    }
    const service = new SetupSessionService(
      {
        capture: vi.fn().mockResolvedValue(frame),
        analyze: vi.fn().mockResolvedValue(profile),
      } as never,
      { load: vi.fn(), save: vi.fn() } as never,
      { request: vi.fn() } as never,
      { getView: () => ({ user: { id: '42' } }) } as never,
      () => new Date('2026-07-12T12:00:00.000Z'),
      resultRepository as never,
      authenticatedApi as never,
    )
    let view = await service.start(selector, preference, 'predictionResult')
    view = service.setRegion(view.sessionId, view.generation, 'resultTrigger', {
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    })
    view = service.setRegion(view.sessionId, view.generation, 'resultData', {
      x: 0.2,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    })
    view = await service.analyzeTrigger(view.sessionId, view.generation)
    view = service.review(view.sessionId, view.generation)
    await expect(service.commit(view.sessionId, view.generation)).resolves.toMatchObject({
      state: 'FAILED',
      error: { code: 'RESULT_SETUP_LOCAL_COMMIT_FAILED' },
    })
    expect(authenticatedApi.request).toHaveBeenCalledTimes(2)
    expect(resultRepository.save).toHaveBeenCalledTimes(1)
  })

  it('projects inner trigger coordinates into source-normalized space', () => {
    const projection = buildLegacyProjection(
      frame,
      {
        trigger: { x: 0.2, y: 0.1, width: 0.5, height: 0.4 },
        normal: { x: 0, y: 0, width: 1, height: 1 },
        precise: { x: 0, y: 0, width: 1, height: 1 },
      },
      profile,
      preference,
      '2026-07-12T12:00:00.000Z',
    )
    expect(projection.trigger_area.trigger_profile.inner_ratio).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.6,
    })
    expect(projection.capture_reference).toMatchObject({
      target_type: 'window',
      target_name: 'Game',
      source_frame_size: frame.size,
    })
  })
})
