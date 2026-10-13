import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { ApiClient } from './api-client'
import type { AuthSession } from './auth-session'
import type { CaptureService } from './capture-service'
import type { CaptureTargetResolver } from './capture-target-resolver'
import { SetupSessionService, buildLegacyProjection } from './setup-session-service'
import { LegacyOcrRegionsSchema } from '../../../shared/models/setup'
import type { SetupRuntimeOutcome } from '../../../shared/models/setup'
import type { PredictionResultConfiguration } from '../../../shared/models/prediction-result'

const profile = {
  schemaVersion: 3 as const,
  analyzer: { name: 'cr-tools-trigger-analyzer' as const, version: '2.0.0' },
  innerRect: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
  structureAlgorithm: 'max-channel-scharr-v1' as const,
  structureHash64: '0123456789abcdef',
  matcherMode: 'edge' as const,
  normalizedTemplateSize: { width: 128, height: 128 },
  structureTemplateBase64: 'AAAA',
  edgeTemplateBase64: 'AAAA',
  orientationTemplateBase64: 'AAAA',
  quality: {
    grade: 'medium' as const,
    score: 0.65,
    edgePixelCount: 120,
    edgeCoverage: 0.5,
    keypointsCount: 3,
    cropConfidence: 0.8,
    cropAreaRatio: 0.48,
  },
}
const legacyProfile = {
  templateGrayBase64: Buffer.from('legacy grayscale png').toString('base64'),
  thumbnailHash: 'fedcba9876543210',
  featureMode: 'ncc' as const,
  keypointsCount: 3,
  normalizedTemplateSize: { width: 128 as const, height: 128 as const },
  hashThreshold: 5 as const,
  orbDistanceThreshold: 55 as const,
  orbMinGoodMatches: 10 as const,
  nccThreshold: 0.72 as const,
  analyzerVersion: 'trigger-profile-v2' as const,
}
const analysis = { profile, legacyProfile, vsOrientation: null, vsBadge: null }
const chrome = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  topEdges: null,
  bottomEdges: null,
  leftEdges: null,
  rightEdges: null,
}
const frame = {
  size: { width: 1000, height: 2000 },
  png: Buffer.from('png'),
  game: {
    rect: { x: 0, y: 0, width: 1000, height: 2000 },
    aspect: 0.5,
    chrome,
    frames: 8,
  },
}
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
  activeProfileId: resultTarget.profileId,
  profiles: [
    {
      profileId: resultTarget.profileId,
      isActive: true,
      configurationRevision: 2,
      configurationFingerprint: 'a'.repeat(64),
    },
  ],
}

function harness(remoteOk = true, resolver?: CaptureTargetResolver) {
  let authGeneration = 1
  const capture = {
    capture: vi.fn().mockResolvedValue(frame),
    analyze: vi.fn().mockResolvedValue(analysis),
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
    undefined,
    undefined,
    resolver,
  )
  return {
    service,
    capture,
    repository,
    apiRequests,
    api,
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
  for (const region of ['trigger', 'nickname', 'topLeftEvidence'] as const) {
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
  it.each(['too_small', 'aspect_out_of_range', 'unstable', 'insufficient_frames'])(
    'refuses a frozen frame without game geometry (%s), and permits a fresh frame',
    async (reason) => {
      const test = harness()
      const failed = await test.service.start(selector, preference, 'capture', {
        ...frame,
        game: { rect: null, reason: reason as 'too_small' },
      })
      expect(failed).toMatchObject({
        state: 'FAILED',
        game: null,
        error: {
          code: 'SETUP_GAME_NOT_FOUND',
          message: 'Не вижу игру в окне — сделайте кадр ещё раз',
        },
      })
      expect(() =>
        test.service.setRegion(failed.sessionId, failed.generation, 'trigger', {
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
        }),
      ).toThrow(expect.objectContaining({ code: 'SETUP_STATE_FINAL' }))
      await expect(
        test.service.commit(failed.sessionId, failed.generation),
      ).rejects.toMatchObject({
        code: 'SETUP_STATE_FINAL',
      })
      expect(test.repository.save).not.toHaveBeenCalled()
      const fresh = await test.service.start(selector, preference, 'capture', frame)
      expect(fresh).toMatchObject({
        state: 'SELECTING',
        game: {
          viewport: { x: 0, y: 0, width: 1, height: 1 },
          aspect: 0.5,
          source: 'freeze',
        },
        regionOrigins: {
          trigger: 'manual',
          nickname: 'manual',
          topLeftEvidence: 'manual',
        },
        triggerKind: null,
      })
    },
  )

  it('never creates a new full-frame profile through a capture without frozen geometry', async () => {
    const test = harness()
    test.capture.capture.mockResolvedValue({ size: frame.size, png: frame.png })
    const failed = await test.service.start(selector, preference)
    expect(failed).toMatchObject({
      state: 'FAILED',
      error: { code: 'SETUP_GAME_NOT_FOUND' },
    })
    expect(test.repository.save).not.toHaveBeenCalled()
    expect(test.capture.analyze).not.toHaveBeenCalled()
  })

  it('converts manual frame zones to game fractions and projects the setup layout back to the server', async () => {
    const test = harness()
    const gameFrame = {
      ...frame,
      game: { ...frame.game, rect: { x: 100, y: 200, width: 800, height: 1600 } },
    }
    test.capture.capture.mockResolvedValue(gameFrame)
    const ready = await readyForCommit(test.service)
    await test.service.commit(ready.sessionId, ready.generation)
    expect(test.capture.analyze).toHaveBeenCalledWith(
      gameFrame,
      { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      expect.any(AbortSignal),
      gameFrame.game.rect,
    )
    expect(test.repository.save.mock.calls[0]?.[0] as unknown).toMatchObject({
      calibration: {
        schemaVersion: 2,
        coordinateSpace: 'game_relative',
        validationStatus: 'validated',
        layouts: [
          {
            layoutSource: 'setup',
            gameAspect: 0.5,
            referenceFrameSize: frame.size,
            referenceGameRect: gameFrame.game.rect,
            windowChrome: chrome,
            triggerRegion: { x: 0, y: 0, width: 0.625, height: 0.625 },
            nicknameRegion: { x: 0, y: 0, width: 0.625, height: 0.625 },
            topLeftEvidenceRegion: { x: 0, y: 0, width: 0.625, height: 0.625 },
            trigger: { kind: 'structural', profile },
            provenance: {
              trigger: { origin: 'manual', confidence: null, analyzerVersion: '2.0.0' },
              nickname: { origin: 'manual', confidence: null, analyzerVersion: null },
              topLeftEvidence: {
                origin: 'manual',
                confidence: null,
                analyzerVersion: null,
              },
              viewport: {
                origin: 'auto',
                confidence: null,
                analyzerVersion: 'm9-geom-1',
              },
            },
          },
        ],
      },
    })
    expect(test.apiRequests[0]).toMatchObject({
      body: {
        trigger_area: {
          x: 100,
          y: 200,
          width: 500,
          height: 1000,
          ratio: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
          trigger_profile: {
            schema_version: 2,
            thumbnail_hash: legacyProfile.thumbnailHash,
          },
        },
      },
    })
  })

  it('rejects manually selected areas outside the detected game without clipping them', async () => {
    const test = harness()
    const started = await test.service.start(selector, preference, 'capture', {
      ...frame,
      game: { ...frame.game, rect: { x: 100, y: 200, width: 800, height: 1600 } },
    })
    expect(() =>
      test.service.setRegion(started.sessionId, started.generation, 'nickname', {
        x: 0,
        y: 0,
        width: 0.2,
        height: 0.2,
      }),
    ).toThrow(expect.objectContaining({ code: 'SETUP_REGION_INVALID' }))
    expect(test.service.getSession().regions.nickname).toBeNull()
  })

  it('uses rule (c) for a recognized VS badge and clears it when the marked trigger changes', async () => {
    const test = harness()
    const badge = { cx: 0.5, cy: 0.43, width: 0.2, height: 0.08 }
    const vsOrientation = {
      kind: 'vs_edge_orientation' as const,
      algorithm: 'vs-orient-1' as const,
      badge,
      normalizedSize: { width: 96 as const, height: 64 },
      cropMargin: 0.08 as const,
      padding: 4 as const,
      maxShift: 3 as const,
      threshold: 0.5 as const,
      angleQ8Base64: Buffer.alloc(96 * 64).toString('base64'),
      weightQ8Base64: Buffer.alloc(96 * 64, 255).toString('base64'),
      templateHash64: '0123456789abcdef',
      maskAreaRatio: 0.5,
    }
    test.capture.analyze.mockResolvedValueOnce({
      ...analysis,
      vsOrientation,
      vsBadge: badge,
    })
    const ready = await readyForCommit(test.service)
    expect(ready.triggerKind).toBe('vs_edge_orientation')
    await test.service.commit(ready.sessionId, ready.generation)
    expect(test.repository.save.mock.calls[0]?.[0] as unknown).toMatchObject({
      calibration: {
        coordinateSpace: 'game_relative',
        layouts: [{ trigger: vsOrientation }],
      },
    })
    let view = await test.service.start(selector, preference)
    view = test.service.setRegion(view.sessionId, view.generation, 'trigger', {
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    })
    view = await test.service.analyzeTrigger(view.sessionId, view.generation)
    expect(view.triggerKind).toBe('structural')
    view = test.service.setRegion(view.sessionId, view.generation, 'trigger', {
      x: 0.2,
      y: 0.2,
      width: 0.2,
      height: 0.2,
    })
    expect(view.triggerProfile).toBeNull()
    expect(view.triggerKind).toBeNull()
  })

  it('keeps result setup full-frame and does not send game geometry to its analyzer', async () => {
    const test = harness()
    const resultFrame = { size: frame.size, png: frame.png }
    test.capture.capture.mockResolvedValue(resultFrame)
    let view = await test.service.start(
      selector,
      preference,
      'predictionResult',
      undefined,
      resultTarget,
    )
    expect(view).toMatchObject({ state: 'SELECTING', game: null, regionOrigins: null })
    view = test.service.setRegion(view.sessionId, view.generation, 'resultTrigger', {
      x: 0,
      y: 0,
      width: 0.1,
      height: 0.1,
    })
    view = await test.service.analyzeTrigger(view.sessionId, view.generation)
    expect(view.triggerKind).toBe('structural')
    expect(test.capture.analyze).toHaveBeenCalledWith(
      resultFrame,
      { x: 0, y: 0, width: 0.1, height: 0.1 },
      expect.any(AbortSignal),
      null,
    )
  })

  it('creates a fresh calibration identity on every setup and recalibration commit', async () => {
    const test = harness()
    const oldId = '00000000-0000-4000-8000-000000000090'
    test.repository.get.mockResolvedValue({
      configuration: {
        revision: 7,
        calibration: {
          calibrationId: oldId,
          revision: 4,
          coordinateSpace: 'full_frame_normalized',
        },
      },
    })
    const firstReady = await readyForCommit(test.service)
    await test.service.commit(firstReady.sessionId, firstReady.generation)
    const first = test.repository.save.mock.calls[0]?.[0] as
      | {
          calibration: { calibrationId: string }
        }
      | undefined
    expect(first?.calibration.calibrationId).not.toBe(oldId)
    expect(first?.calibration.calibrationId).toMatch(/^[a-f0-9-]{36}$/)
    const secondReady = await readyForCommit(test.service)
    await test.service.commit(secondReady.sessionId, secondReady.generation)
    const second = test.repository.save.mock.calls[1]?.[0] as
      | {
          calibration: { calibrationId: string }
        }
      | undefined
    expect(second?.calibration.calibrationId).not.toBe(first?.calibration.calibrationId)
    expect(second?.calibration.calibrationId).not.toBe(oldId)
    for (const call of test.repository.save.mock.calls) {
      expect(call[0] as unknown).toMatchObject({
        calibration: {
          coordinateSpace: 'game_relative',
          revision: 5,
          layouts: [expect.objectContaining({ layoutSource: 'setup' })],
        },
      })
    }
  })

  it('M6 #11 marks the saved projection unsent when auth changes immediately after local persistence', async () => {
    const test = harness()
    const ready = await readyForCommit(test.service)
    test.repository.save.mockImplementationOnce(() => {
      test.changeAuthContext()
      return Promise.resolve()
    })
    const saved = await test.service.commit(ready.sessionId, ready.generation)
    expect(saved).toMatchObject({
      state: 'CANCELLED',
      saveOutcome: { local: 'saved', projection: 'failed', warning: 'SETUP_SYNC_FAILED' },
    })
    expect(test.apiRequests).toHaveLength(0)
  })
  it('does not expose or close a previous auth generation through setup getters', async () => {
    const test = harness()
    const view = await test.service.start(selector, preference)
    test.changeAuthContext()
    test.service.cancelForAuthTransition()
    expect(() => test.service.getSession()).toThrow(
      expect.objectContaining({ code: 'AUTH_CONTEXT_CHANGED' }),
    )
    expect(() => test.service.getFrame(view.sessionId, view.generation + 1)).toThrow(
      expect.objectContaining({ code: 'AUTH_CONTEXT_CHANGED' }),
    )
    expect(() => test.service.close(view.sessionId, view.generation + 1)).toThrow(
      expect.objectContaining({ code: 'AUTH_CONTEXT_CHANGED' }),
    )
  })

  it('starts result setup on the selected profile without changing the active profile', async () => {
    const resolved = {
      userId: '42',
      profileId: resultTarget.profileId,
      profileName: 'Второй',
      collectionRevision: 3,
      selector,
      configuration: { sourceBinding: { identity: preference } },
    }
    const resolver = {
      resolveProfileTarget: vi.fn().mockResolvedValue(resolved),
      resolveActiveProfile: vi.fn(),
    }
    const test = harness(true, resolver as never)
    const view = await test.service.startPredictionResult(resultTarget.profileId, 3)
    expect(view).toMatchObject({
      state: 'SELECTING',
      kind: 'predictionResult',
      profileId: resultTarget.profileId,
      profileName: 'Второй',
    })
    expect(resolver.resolveProfileTarget).toHaveBeenCalledWith(resultTarget.profileId)
    expect(resolver.resolveActiveProfile).not.toHaveBeenCalled()
    expect(test.repository.save).not.toHaveBeenCalled()
    expect(test.capture.capture).toHaveBeenCalledWith(selector, expect.any(AbortSignal))
  })

  it('fences profile revision and auth generation before capturing result setup', async () => {
    const gate = Promise.withResolvers<unknown>()
    const resolver = { resolveProfileTarget: vi.fn().mockReturnValue(gate.promise) }
    const test = harness(true, resolver as never)
    const starting = test.service.startPredictionResult(resultTarget.profileId, 1)
    test.changeAuthContext()
    gate.resolve({ userId: '42', collectionRevision: 1 })
    await expect(starting).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' })
    expect(test.capture.capture).not.toHaveBeenCalled()
    resolver.resolveProfileTarget.mockResolvedValue({
      userId: '42',
      collectionRevision: 2,
    })
    await expect(
      test.service.startPredictionResult(resultTarget.profileId, 1),
    ).rejects.toMatchObject({ code: 'CAPTURE_PROFILE_STALE' })
    expect(test.capture.capture).not.toHaveBeenCalled()
  })

  it('cancels an in-flight saved projection on auth change without restarting runtime', async () => {
    const test = harness()
    const ready = await readyForCommit(test.service)
    const gate = Promise.withResolvers<{
      ok: true
      status: number
      data: { success: boolean }
    }>()
    test.api.request.mockImplementation(() => gate.promise)
    const runtime = vi
      .fn<(activeChanged: boolean) => Promise<SetupRuntimeOutcome>>()
      .mockResolvedValue('not_requested')
    test.service.configureCaptureProfileLifecycle(
      () => undefined,
      runtime,
      (operation) => operation(),
    )
    const committing = test.service.commit(ready.sessionId, ready.generation)
    await vi.waitFor(() => expect(test.repository.save).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(test.api.request).toHaveBeenCalledOnce())
    test.changeAuthContext()
    gate.resolve({ ok: true, status: 200, data: { success: true } })
    expect(await committing).toMatchObject({
      state: 'CANCELLED',
      saveOutcome: { local: 'saved' },
    })
    expect(runtime).not.toHaveBeenCalled()
  })

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
    let release: ((value: typeof analysis) => void) | undefined
    capture.analyze.mockImplementation(
      () =>
        new Promise<typeof analysis>((resolve) => {
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
    release?.(analysis)
    await expect(analyzing).resolves.toMatchObject({ state: 'CANCELLED' })
    expect(cancelled.state).toBe('CANCELLED')
  })

  it('keeps the durable local configuration when projection sync fails', async () => {
    const { service, repository } = harness(false)
    const view = await readyForCommit(service)
    await expect(service.commit(view.sessionId, view.generation)).resolves.toMatchObject({
      state: 'COMMITTED',
      saveOutcome: { local: 'saved', projection: 'failed', warning: 'SETUP_SYNC_FAILED' },
    })
    expect(repository.save).toHaveBeenCalledOnce()
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

  it('atomically commits locally before posting the exact legacy projection', async () => {
    const { service, repository, apiRequests } = harness()
    const view = await readyForCommit(service)
    expect(view).not.toHaveProperty('legacyProfile')
    expect(view).not.toHaveProperty('legacyTriggerProfile')
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
        y: 200,
        width: 500,
        height: 1000,
        trigger_profile: {
          schema_version: 2,
          template_gray_base64: legacyProfile.templateGrayBase64,
          thumbnail_hash: legacyProfile.thumbnailHash,
          hash_algorithm: 'ahash64-hex-char-v1',
          feature_mode: 'ncc',
          hash_threshold: 5,
          orb_distance_threshold: 55,
          orb_min_good_matches: 10,
          ncc_threshold: 0.72,
        },
      },
      normal_data_area: { x: 100, y: 200 },
      precise_data_area: { x: 100, y: 200 },
      screen_resolution: { width: 1000, height: 2000 },
    })
    const expectedCalibration: unknown = expect.objectContaining({
      coordinateSpace: 'game_relative',
      layouts: [expect.objectContaining({ trigger: { kind: 'structural', profile } })],
    })
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '42',
        revision: 1,
        sourceBinding: {
          identity: preference,
          lastVerifiedAt: '2026-07-12T12:00:00.000Z',
        },
        calibration: expectedCalibration,
      }),
      expect.objectContaining({ profileName: 'Основной', expectedRevision: 0 }),
    )
    const persisted: unknown = repository.save.mock.calls[0]?.[0]
    expect(persisted).not.toHaveProperty('legacyProfile')
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
    const committed = vi.fn().mockResolvedValue('not_requested')
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
    expect(committed).not.toHaveBeenCalled()
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
    const lifecycle = Promise.withResolvers<SetupRuntimeOutcome>()
    const committed = vi.fn(() => lifecycle.promise)
    service.configureCaptureProfileLifecycle(vi.fn(), committed, (operation) =>
      operation(),
    )
    const view = await readyForCommit(service)
    const committing = service.commit(view.sessionId, view.generation)
    await vi.waitFor(() => expect(committed).toHaveBeenCalled())

    service.cancelForAuthTransition()
    lifecycle.resolve('ready')

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
    view = service.setRegion(view.sessionId, view.generation, 'nickname', {
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.3,
    })

    const finished = await service.finish(
      view.sessionId,
      view.generation,
      'topLeftEvidence',
      {
        x: 0.15,
        y: 0.15,
        width: 0.6,
        height: 0.6,
      },
    )

    expect(finished.state).toBe('COMMITTED')
    expect(capture.analyze).toHaveBeenCalledTimes(1)
    expect(repository.save).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'keeps saved local result zones when projection fails (calibration binding: %s)',
    async (gameRelative) => {
      const capture = {
        capture: vi.fn().mockResolvedValue(frame),
        analyze: vi.fn().mockResolvedValue(analysis),
      }
      const resultRepository = {
        load: vi.fn().mockResolvedValue(null),
        save: vi
          .fn<
            (
              configuration: PredictionResultConfiguration,
              profileId: string,
            ) => Promise<void>
          >()
          .mockResolvedValue(undefined),
      }
      const resultRequests: { path: string; body: unknown }[] = []
      const rawApi = {
        request: vi.fn((request: { path: string; body: unknown }) => {
          resultRequests.push(request)
          return Promise.resolve(
            resultRequests.length === 1
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
          list: vi.fn().mockResolvedValue({
            ...resultProfileStatus,
            profiles: resultProfileStatus.profiles.map((profile) => ({
              ...profile,
              ...(gameRelative ? { calibrationId: resultTarget.profileId } : {}),
            })),
          }),
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
        state: 'COMMITTED',
        saveOutcome: {
          local: 'saved',
          projection: 'failed',
          warning: 'SETUP_SYNC_FAILED',
        },
      })
      expect(resultRequests.map((request) => request.path)).toEqual([
        '/api/streamer/result-trigger-area',
        '/api/streamer/result-data-area',
      ])
      expect(resultRequests[0]?.body).toMatchObject({
        trigger_profile: {
          template_gray_base64: legacyProfile.templateGrayBase64,
          thumbnail_hash: legacyProfile.thumbnailHash,
          feature_mode: legacyProfile.featureMode,
          hash_threshold: 5,
        },
      })
      expect(resultRepository.save).toHaveBeenCalledOnce()
      expect(resultRepository.save.mock.calls[0]?.[0].captureCalibrationId).toBe(
        gameRelative ? resultTarget.profileId : undefined,
      )
    },
  )

  it('does not change the server when the local result commit fails', async () => {
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
        analyze: vi.fn().mockResolvedValue(analysis),
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
    expect(rawApi.request).not.toHaveBeenCalled()
    expect(resultRepository.save).toHaveBeenCalledTimes(1)
  })

  it('projects inner trigger coordinates into source-normalized space', () => {
    const projection = buildLegacyProjection(
      frame,
      {
        trigger: { x: 0.2, y: 0.1, width: 0.5, height: 0.4 },
        nickname: { x: 0, y: 0, width: 1, height: 1 },
        topLeftEvidence: { x: 0, y: 0, width: 1, height: 1 },
      },
      profile,
      legacyProfile,
      preference,
      '2026-07-12T12:00:00.000Z',
    )
    expect(projection.trigger_area.trigger_profile.inner_ratio).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.6,
    })
    expect(projection.trigger_area.trigger_profile).toMatchObject({
      schema_version: 2,
      template_gray_base64: legacyProfile.templateGrayBase64,
      thumbnail_hash: legacyProfile.thumbnailHash,
      feature_mode: 'ncc',
      hash_threshold: 5,
    })
    expect(projection.capture_reference).toMatchObject({
      target_type: 'window',
      target_name: 'Game',
      source_frame_size: frame.size,
    })
  })

  it('canonicalizes a half-pixel trigger before analysis and persistence', async () => {
    const { service, capture, repository } = harness()
    let view = await service.start(selector, preference)
    view = service.setRegion(view.sessionId, view.generation, 'trigger', {
      x: 0.0505,
      y: 0.101,
      width: 0.2005,
      height: 0.201,
    })
    for (const region of ['nickname', 'topLeftEvidence'] as const) {
      view = service.setRegion(view.sessionId, view.generation, region, {
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.5,
      })
    }
    view = await service.analyzeTrigger(view.sessionId, view.generation)
    view = service.review(view.sessionId, view.generation)
    await service.commit(view.sessionId, view.generation)

    const canonical = { x: 0.051, y: 0.101, width: 0.2, height: 0.201 }
    expect(capture.analyze).toHaveBeenCalledWith(
      frame,
      canonical,
      expect.any(AbortSignal),
      frame.game.rect,
    )
    expect(repository.save).toHaveBeenCalled()
    expect(repository.save.mock.calls[0]?.[0] as unknown).toMatchObject({
      calibration: { layouts: [expect.objectContaining({ triggerRegion: canonical })] },
    })
  })

  it('reports a saved calibration and failed runtime independently', async () => {
    const test = harness()
    test.service.configureCaptureProfileLifecycle(
      () => undefined,
      () => Promise.reject(new Error('restart failed')),
      (operation) => operation(),
    )
    const ready = await readyForCommit(test.service)
    const saved = await test.service.commit(ready.sessionId, ready.generation)
    expect(saved).toMatchObject({
      state: 'COMMITTED',
      saveOutcome: {
        local: 'saved',
        projection: 'synced',
        runtime: 'failed',
        warning: 'SETUP_RUNTIME_FAILED',
      },
    })
    expect(test.repository.save).toHaveBeenCalledOnce()
  })

  it('retries a failed saved projection without saving again, with session/auth fences', async () => {
    const test = harness(false)
    const ready = await readyForCommit(test.service)
    const saved = await test.service.commit(ready.sessionId, ready.generation)
    const config = test.repository.save.mock.calls[0]?.[0] as { fingerprint: string }
    test.repository.get.mockResolvedValue({ configuration: config })
    test.repository.list.mockResolvedValue({ activeProfileId: saved.profileId })
    test.api.request.mockResolvedValue({ ok: true, status: 200, data: { success: true } })
    await expect(
      test.service.retrySync(saved.sessionId, saved.generation + 1),
    ).rejects.toMatchObject({ code: 'SETUP_SESSION_STALE' })
    const synced = await test.service.retrySync(saved.sessionId, saved.generation)
    expect(synced).toMatchObject({
      state: 'COMMITTED',
      saveOutcome: { local: 'saved', projection: 'synced', warning: null },
    })
    expect(test.repository.save).toHaveBeenCalledOnce()
    test.changeAuthContext()
    await expect(
      test.service.retrySync(synced.sessionId, synced.generation),
    ).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' })
  })

  it('never resends an obsolete saved projection after calibration change', async () => {
    const test = harness(false)
    const ready = await readyForCommit(test.service)
    const saved = await test.service.commit(ready.sessionId, ready.generation)
    test.repository.get.mockResolvedValue({ configuration: { fingerprint: 'different' } })
    test.repository.list.mockResolvedValue({ activeProfileId: saved.profileId })
    expect(await test.service.retrySync(saved.sessionId, saved.generation)).toMatchObject(
      { state: 'COMMITTED', error: { code: 'CAPTURE_PROFILE_STALE' } },
    )
    expect(test.apiRequests).toHaveLength(1)
    expect(test.repository.save).toHaveBeenCalledOnce()
  })

  it('does not send a projection when atomic capture persistence fails', async () => {
    const test = harness()
    const ready = await readyForCommit(test.service)
    test.repository.save.mockRejectedValueOnce(new Error('disk full'))
    expect(await test.service.commit(ready.sessionId, ready.generation)).toMatchObject({
      state: 'FAILED',
      saveOutcome: { local: 'failed', projection: 'not_attempted' },
    })
    expect(test.apiRequests).toHaveLength(0)
  })
})
