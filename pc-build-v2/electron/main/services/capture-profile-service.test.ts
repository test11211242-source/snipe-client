import { describe, expect, it, vi } from 'vitest'

import type {
  CaptureProfileCollectionStatus,
  GameLayout,
} from '../../../shared/models/capture'
import { ApplicationError } from '../../../shared/errors/application-error'
import { CaptureProfileService } from './capture-profile-service'
import { monitorLearnedLayoutFixture } from '../../../tests/monitor-fixtures'

const PRIMARY_ID = '00000000-0000-4000-8000-000000000001'
const SECONDARY_ID = '00000000-0000-4000-8000-000000000002'

function summary(profileId: string, profileName: string, isActive: boolean) {
  return {
    profileId,
    profileName,
    isActive,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
    configurationRevision: 1,
    configurationFingerprint: 'a'.repeat(64),
    committedAt: '2026-07-17T10:00:00.000Z',
    sourceKind: 'window' as const,
    sourceLabel: profileName,
    sourceHealth: { state: 'unknown' as const, reason: null },
    calibrationHealth: 'validated' as const,
  }
}

function status(
  activeProfileId = PRIMARY_ID,
  revision = 1,
): CaptureProfileCollectionStatus {
  return {
    userId: 'user-1',
    revision,
    fingerprint: 'b'.repeat(64),
    activeProfileId,
    profileCount: 2,
    profiles: [
      summary(PRIMARY_ID, 'Основной', activeProfileId === PRIMARY_ID),
      summary(SECONDARY_ID, 'Второй', activeProfileId === SECONDARY_ID),
    ],
  }
}

function harness(resultRepository?: object) {
  let userId = 'user-1'
  let authGeneration = 1
  let current = status()
  const repository = {
    load: vi.fn().mockResolvedValue({
      revision: 1,
      sourceBinding: { identity: { label: 'Game' } },
    }),
    list: vi.fn(() => Promise.resolve(current)),
    get: vi.fn(),
    activate: vi.fn((_userId: string, profileId: string) => {
      current = status(profileId, current.revision + 1)
      return Promise.resolve(current)
    }),
    rename: vi.fn(),
    duplicate: vi.fn(),
    delete: vi.fn(),
    rebind: vi.fn(),
    appendLearnedLayout: vi
      .fn<
        (
          userId: string,
          profileId: string,
          calibrationId: string,
          layout: GameLayout,
        ) => Promise<number>
      >()
      .mockResolvedValue(2),
  }
  const monitorView = {
    state: 'READY' as const,
    preferences: { deckMode: 'pol' as const },
    readiness: {
      authenticated: true,
      captureConfigured: true,
      sourceAvailable: true,
    },
    error: null,
    startedAt: '2026-07-17T10:00:00.000Z',
    stats: {
      triggers: 0,
      requests: 0,
      droppedActions: 0,
      playersFound: 0,
      playersNotFound: 0,
      recognitionFailures: 0,
      serviceErrors: 0,
    },
    results: [],
    runIntent: false,
    search: null,
    session: null,
    summary: null,
    historyError: null,
  }
  const monitor = {
    getView: vi.fn().mockResolvedValue(monitorView),
    stop: vi.fn().mockResolvedValue(monitorView),
    start: vi.fn().mockResolvedValue(monitorView),
    restartIfActive: vi.fn().mockResolvedValue(monitorView),
    invalidateCaptureTarget: vi.fn().mockReturnValue(monitorView),
  }
  const targetResolver = {
    resolveProfile: vi.fn().mockResolvedValue({}),
    resolveProfiles: vi.fn().mockResolvedValue(
      new Map([
        [PRIMARY_ID, null],
        [SECONDARY_ID, null],
      ]),
    ),
  }
  const onContextChanged = vi.fn()
  const service = new CaptureProfileService(
    {
      getView: () => ({ user: { id: userId } }),
      getContextGeneration: () => authGeneration,
    } as never,
    repository as never,
    targetResolver as never,
    monitor as never,
    onContextChanged,
    resultRepository as never,
  )
  return {
    service,
    repository,
    monitor,
    targetResolver,
    onContextChanged,
    changeAuthContext: (nextUserId: string) => {
      userId = nextUserId
      authGeneration += 1
    },
  }
}

describe('CaptureProfileService', () => {
  it('preflights and atomically switches a running monitor to another profile', async () => {
    const { service, repository, monitor, targetResolver } = harness()

    await expect(service.activate(SECONDARY_ID, 1)).resolves.toMatchObject({
      profiles: { activeProfileId: SECONDARY_ID, revision: 2 },
      monitor: { state: 'READY' },
    })
    expect(targetResolver.resolveProfile).toHaveBeenCalledWith(SECONDARY_ID)
    expect(repository.activate).toHaveBeenCalledWith('user-1', SECONDARY_ID, 1)
    expect(monitor.restartIfActive).toHaveBeenCalledTimes(1)
  })

  it('notifies prediction readiness after profile activation without a prediction-state lock', async () => {
    const { service, repository, onContextChanged } = harness()
    await expect(service.activate(SECONDARY_ID, 1)).resolves.toMatchObject({
      monitor: { state: 'READY' },
    })
    expect(repository.activate).toHaveBeenCalledWith('user-1', SECONDARY_ID, 1)
    expect(onContextChanged).toHaveBeenCalledOnce()
  })

  it('serializes setup commits and profile activation through one lifecycle lock', async () => {
    const { service, repository } = harness()
    let release: (() => void) | undefined
    const commit = service.runCaptureCommit(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    const activation = service.activate(SECONDARY_ID, 1)
    await Promise.resolve()
    expect(repository.activate).not.toHaveBeenCalled()
    release?.()
    await Promise.all([commit, activation])
    expect(repository.activate).toHaveBeenCalledTimes(1)
  })

  it('keeps a queued profile command bound to the caller auth context', async () => {
    const { service, repository, changeAuthContext } = harness()
    let release: (() => void) | undefined
    const commit = service.runCaptureCommit(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))

    const rename = service.rename(PRIMARY_ID, 'Renamed', 1)
    changeAuthContext('user-2')
    release?.()
    await commit

    await expect(rename).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' })
    expect(repository.rename).not.toHaveBeenCalled()
  })

  it('cancels monitoring after active profile deletion even if result cleanup fails', async () => {
    const resultRepository = {
      load: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockRejectedValue(new Error('disk cleanup failed')),
    }
    const { service, repository, monitor } = harness(resultRepository)
    repository.delete.mockImplementation(() => Promise.resolve(status(SECONDARY_ID, 2)))
    repository.list
      .mockResolvedValueOnce(status(PRIMARY_ID, 1))
      .mockResolvedValue(status(SECONDARY_ID, 2))

    await expect(service.delete(PRIMARY_ID, 1)).resolves.toMatchObject({
      profiles: { activeProfileId: SECONDARY_ID },
    })
    expect(resultRepository.delete).toHaveBeenCalledWith('user-1', PRIMARY_ID)
    expect(monitor.stop).toHaveBeenCalledWith('profile_deleted')
    expect(monitor.restartIfActive).not.toHaveBeenCalled()
  })

  it('rejects source rebinding when the aspect ratio would invalidate regions', async () => {
    const { service, repository } = harness()
    repository.get.mockResolvedValue({
      configuration: {
        calibration: {
          coordinateSpace: 'full_frame_normalized',
          referenceFrameSize: { width: 1920, height: 1080 },
        },
      },
    })

    await expect(
      service.rebind(
        SECONDARY_ID,
        {
          kind: 'window',
          label: 'Other',
          titleHint: 'Other',
          executableLabel: 'Game.exe',
          windowHwnd: '42',
        },
        { width: 1024, height: 768 },
        1,
      ),
    ).rejects.toMatchObject({ code: 'CAPTURE_PROFILE_GEOMETRY_MISMATCH' })
    expect(repository.rebind).not.toHaveBeenCalled()
  })

  it('rebinds game-relative profiles across source aspect changes', async () => {
    const test = harness()
    test.repository.get.mockResolvedValue({
      configuration: {
        calibration: { coordinateSpace: 'game_relative', calibrationId: PRIMARY_ID },
      },
    })
    await expect(
      test.service.rebind(
        SECONDARY_ID,
        { kind: 'display', label: 'Screen', displayId: '1' },
        { width: 1024, height: 768 },
        1,
      ),
    ).resolves.toMatchObject({ profiles: { revision: 1 } })
    expect(test.repository.rebind).toHaveBeenCalledWith(
      'user-1',
      SECONDARY_ID,
      { kind: 'display', label: 'Screen', displayId: '1' },
      1,
      { width: 1024, height: 768 },
    )
  })

  it('appends a learned layout while predictions run without rewriting result binding or restarting', async () => {
    const results = {
      load: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
    }
    const test = harness(results)
    const learned = monitorLearnedLayoutFixture()
    await expect(
      test.service.appendLearnedLayout('user-1', PRIMARY_ID, PRIMARY_ID, learned),
    ).resolves.toBe(2)
    expect(test.repository.appendLearnedLayout).toHaveBeenCalledWith(
      'user-1',
      PRIMARY_ID,
      PRIMARY_ID,
      expect.objectContaining({
        layoutId: learned.layoutId,
        layoutSource: 'learned',
        calibratedAt: learned.calibratedAt,
        provenance: {
          trigger: { origin: 'auto', confidence: 0.9, analyzerVersion: 'vs-orient-1' },
          nickname: { origin: 'auto', confidence: 0.9, analyzerVersion: 'm9-geom-1' },
          topLeftEvidence: {
            origin: 'auto',
            confidence: 0.9,
            analyzerVersion: 'm9-geom-1',
          },
          viewport: { origin: 'auto', confidence: 0.9, analyzerVersion: 'm9-geom-1' },
        },
      }),
    )
    expect(results.save).not.toHaveBeenCalled()
    expect(test.monitor.restartIfActive).not.toHaveBeenCalled()
    expect(test.monitor.invalidateCaptureTarget).not.toHaveBeenCalled()
  })

  it('persists transferred manual-zone provenance instead of reverting to auto', async () => {
    const test = harness()
    await test.service.appendLearnedLayout('user-1', PRIMARY_ID, PRIMARY_ID, {
      ...monitorLearnedLayoutFixture(),
      zonesOrigin: { nickname: 'manual', topLeftEvidence: 'manual' },
    })
    expect(
      test.repository.appendLearnedLayout.mock.calls[0]?.[3].provenance,
    ).toMatchObject({
      nickname: { origin: 'manual', confidence: null, analyzerVersion: null },
      topLeftEvidence: { origin: 'manual', confidence: null, analyzerVersion: null },
    })
  })

  it('rejects learned layouts from a different signed-in user', async () => {
    const test = harness()
    await expect(
      test.service.appendLearnedLayout(
        'user-2',
        PRIMARY_ID,
        PRIMARY_ID,
        monitorLearnedLayoutFixture(),
      ),
    ).rejects.toMatchObject({ code: 'LAYOUT_STALE' })
    expect(test.repository.appendLearnedLayout).not.toHaveBeenCalled()
  })

  it.each(['LAYOUT_STALE', 'LAYOUT_LIMIT', 'LAYOUT_SAVE_FAILED'])(
    'propagates %s without restarting monitoring',
    async (code) => {
      const test = harness()
      test.repository.appendLearnedLayout.mockRejectedValue(
        new ApplicationError(code, code),
      )
      await expect(
        test.service.appendLearnedLayout(
          'user-1',
          PRIMARY_ID,
          PRIMARY_ID,
          monitorLearnedLayoutFixture(),
        ),
      ).rejects.toMatchObject({ code })
      expect(test.monitor.restartIfActive).not.toHaveBeenCalled()
    },
  )
})

describe('review regression profile source projection', () => {
  it('#8 uses one batched source snapshot rather than resolving each profile', async () => {
    const test = harness()
    await test.service.getView()
    expect(test.targetResolver.resolveProfiles).toHaveBeenCalledExactlyOnceWith([
      PRIMARY_ID,
      SECONDARY_ID,
    ])
    expect(test.targetResolver.resolveProfile).not.toHaveBeenCalled()
  })
})

describe('review regression rebind-required profile health', () => {
  it('#3 projects missing identity as metadata_unavailable and needs_validation', async () => {
    const test = harness()
    test.targetResolver.resolveProfiles.mockResolvedValue(
      new Map<string, ApplicationError | null>([
        [PRIMARY_ID, new ApplicationError('SOURCE_REBIND_REQUIRED', 'Identity missing')],
        [SECONDARY_ID, null],
      ]),
    )
    const view = await test.service.getView()
    expect(view.profiles[0]).toMatchObject({
      sourceHealth: { state: 'metadata_unavailable', reason: 'SOURCE_REBIND_REQUIRED' },
      calibrationHealth: 'needs_validation',
    })
    expect(view.profiles[1]).toMatchObject({ sourceHealth: { state: 'available' } })
  })
})
