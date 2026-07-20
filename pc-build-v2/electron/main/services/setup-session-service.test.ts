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
const resultTarget = {
  profileId: '00000000-0000-4000-8000-000000000001',
  profileName: 'Основной',
  expectedRevision: 1,
}
const resultProfileStatus = {
  revision: 1,
  profiles: [
    {
      profileId: resultTarget.profileId,
      configurationRevision: 2,
      configurationFingerprint: 'a'.repeat(64),
    },
  ],
}

function harness(remoteOk = true) {
  let authGeneration = 1
  const capture = {
    capture: vi.fn().mockResolvedValue(frame),
    analyze: vi.fn().mockResolvedValue(profile),
  }
  const repository = {
    load: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
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
    getContextGeneration: () => authGeneration,
    getAccessToken: vi.fn().mockResolvedValue('secret'),
  }
  const service = new SetupSessionService(
    capture as unknown as CaptureService,
    repository as unknown as CaptureConfigurationRepository,
    api as unknown as ApiClient,
    auth as unknown as AuthSession,
    () => new Date('2026-07-12T12:00:00.000Z'),
  )
  return {
    service,
    capture,
    repository,
    apiRequests,
    changeAuthContext: () => {
      authGeneration += 1
    },
  }
}

async function readyForCommit(
  service: SetupSessionService,
  target?: {
    profileId: string
    profileName: string
    expectedRevision: number
  },
) {
  let view = await service.start(selector, preference, 'capture', undefined, target)
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

  it('fails closed when the capture profile collection changes during setup', async () => {
    const { service, repository, apiRequests } = harness()
    repository.list.mockResolvedValueOnce(null).mockResolvedValueOnce({ revision: 2 })
    const view = await readyForCommit(service)

    await expect(service.commit(view.sessionId, view.generation)).resolves.toMatchObject({
      state: 'REVIEW',
      error: { code: 'CAPTURE_PROFILE_STALE' },
    })
    expect(apiRequests).toHaveLength(0)
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('rejects a new profile at the local limit before changing remote regions', async () => {
    const { service, repository, apiRequests } = harness()
    repository.list.mockResolvedValue({
      revision: 1,
      profileCount: 20,
      profiles: Array.from({ length: 20 }, (_, index) => ({
        profileId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        profileName: `Profile ${index + 1}`,
      })),
    })
    const view = await readyForCommit(service, {
      profileId: '00000000-0000-4000-8000-000000000099',
      profileName: 'One too many',
      expectedRevision: 1,
    })

    await expect(service.commit(view.sessionId, view.generation)).resolves.toMatchObject({
      state: 'REVIEW',
      error: { code: 'CAPTURE_PROFILE_LIMIT' },
    })
    expect(apiRequests).toHaveLength(0)
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
      expect.objectContaining({ profileName: 'Основной', expectedRevision: 0 }),
    )
  })

  it('keeps an edited inactive profile inactive and does not replace the remote active mirror', async () => {
    const { service, repository, apiRequests } = harness()
    repository.list.mockResolvedValue({
      revision: 1,
      profileCount: 2,
      profiles: [
        {
          profileId: resultTarget.profileId,
          profileName: resultTarget.profileName,
          isActive: false,
        },
        {
          profileId: '00000000-0000-4000-8000-000000000002',
          profileName: 'Active',
          isActive: true,
        },
      ],
    })
    const committed = vi.fn().mockResolvedValue(undefined)
    service.configureCaptureProfileLifecycle(vi.fn(), committed, (operation) =>
      operation(),
    )
    const view = await readyForCommit(service, resultTarget)

    await expect(service.commit(view.sessionId, view.generation)).resolves.toMatchObject({
      state: 'COMMITTED',
    })
    expect(apiRequests).toHaveLength(0)
    expect(repository.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ profileId: resultTarget.profileId, activate: false }),
    )
    expect(committed).toHaveBeenCalledWith(false)
  })

  it('rejects setup commands after the auth generation changes', async () => {
    const { service, repository, changeAuthContext } = harness()
    const view = await readyForCommit(service)
    changeAuthContext()

    await expect(service.commit(view.sessionId, view.generation)).rejects.toMatchObject({
      code: 'AUTH_CONTEXT_CHANGED',
    })
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('does not resurrect a setup cancelled while a repository read is pending', async () => {
    const { service, repository } = harness()
    const view = await readyForCommit(service, resultTarget)
    let resolveProfiles!: (value: typeof resultProfileStatus) => void
    repository.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProfiles = resolve
      }),
    )
    const committing = service.commit(view.sessionId, view.generation)
    await vi.waitFor(() => expect(repository.list).toHaveBeenCalled())

    service.cancelForAuthTransition()
    resolveProfiles(resultProfileStatus)

    await expect(committing).resolves.toMatchObject({ state: 'CANCELLED' })
    await expect(
      service.start(selector, preference, 'capture', undefined, resultTarget),
    ).resolves.toMatchObject({ state: 'SELECTING' })
    expect(repository.save).not.toHaveBeenCalled()
  })

  it('does not commit a setup cancelled during monitor lifecycle refresh', async () => {
    const { service } = harness()
    let releaseLifecycle!: () => void
    const lifecycle = new Promise<void>((resolve) => {
      releaseLifecycle = resolve
    })
    const committed = vi.fn(() => lifecycle)
    service.configureCaptureProfileLifecycle(vi.fn(), committed, (operation) =>
      operation(),
    )
    const view = await readyForCommit(service)
    const committing = service.commit(view.sessionId, view.generation)
    await vi.waitFor(() => expect(committed).toHaveBeenCalled())

    service.cancelForAuthTransition()
    releaseLifecycle()

    await expect(committing).resolves.toMatchObject({ state: 'CANCELLED' })
  })

  it('uses a prepared click-time frame and completes the final region in one command', async () => {
    const { service, capture, repository } = harness()
    let view = await service.start(selector, preference, 'capture', frame)
    expect(capture.capture).not.toHaveBeenCalled()
    view = service.setRegion(view.sessionId, view.generation, 'trigger', {
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    })
    view = service.setRegion(view.sessionId, view.generation, 'normal', {
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.3,
    })

    const finished = await service.finish(view.sessionId, view.generation, 'precise', {
      x: 0.15,
      y: 0.15,
      width: 0.6,
      height: 0.6,
    })

    expect(finished.state).toBe('COMMITTED')
    expect(capture.analyze).toHaveBeenCalledTimes(1)
    expect(repository.save).toHaveBeenCalledTimes(1)
  })

  it('reports partial remote result setup and does not activate local configuration', async () => {
    const capture = {
      capture: vi.fn().mockResolvedValue(frame),
      analyze: vi.fn().mockResolvedValue(profile),
    }
    const resultRepository = { load: vi.fn().mockResolvedValue(null), save: vi.fn() }
    const resultPaths: string[] = []
    const rawApi = {
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
      {
        load: vi.fn(),
        save: vi.fn(),
        list: vi.fn().mockResolvedValue(resultProfileStatus),
      } as never,
      rawApi as never,
      {
        getView: () => ({ user: { id: '42' } }),
        getContextGeneration: () => 1,
        getAccessToken: vi.fn().mockResolvedValue('secret'),
      } as never,
      () => new Date('2026-07-12T12:00:00.000Z'),
      resultRepository as never,
      { request: vi.fn() } as never,
    )
    let view = await service.start(
      selector,
      preference,
      'predictionResult',
      undefined,
      resultTarget,
    )
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
    const rawApi = {
      request: vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, data: { success: true } }),
    }
    const service = new SetupSessionService(
      {
        capture: vi.fn().mockResolvedValue(frame),
        analyze: vi.fn().mockResolvedValue(profile),
      } as never,
      {
        load: vi.fn(),
        save: vi.fn(),
        list: vi.fn().mockResolvedValue(resultProfileStatus),
      } as never,
      rawApi as never,
      {
        getView: () => ({ user: { id: '42' } }),
        getContextGeneration: () => 1,
        getAccessToken: vi.fn().mockResolvedValue('secret'),
      } as never,
      () => new Date('2026-07-12T12:00:00.000Z'),
      resultRepository as never,
      { request: vi.fn() } as never,
    )
    let view = await service.start(
      selector,
      preference,
      'predictionResult',
      undefined,
      resultTarget,
    )
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
    expect(rawApi.request).toHaveBeenCalledTimes(2)
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
