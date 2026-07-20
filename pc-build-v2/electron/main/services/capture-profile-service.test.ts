import { describe, expect, it, vi } from 'vitest'

import type { CaptureProfileCollectionStatus } from '../../../shared/models/capture'
import { CaptureProfileService } from './capture-profile-service'

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

function harness(predictionState = 'stopped', resultRepository?: object) {
  let userId = 'user-1'
  let authGeneration = 1
  let current = status()
  const repository = {
    load: vi.fn().mockResolvedValue({
      revision: 1,
      source: { label: 'Game' },
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
  }
  const monitorView = {
    state: 'READY' as const,
    preferences: { searchMode: 'fast' as const, deckMode: 'pol' as const },
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
  }
  const monitor = {
    getView: vi.fn().mockResolvedValue(monitorView),
    stop: vi.fn().mockResolvedValue(monitorView),
    start: vi.fn().mockResolvedValue(monitorView),
    restartIfActive: vi.fn().mockResolvedValue(monitorView),
    invalidateCaptureTarget: vi.fn().mockReturnValue(monitorView),
  }
  const targetResolver = { resolveProfile: vi.fn().mockResolvedValue({}) }
  const service = new CaptureProfileService(
    {
      getView: () => ({ user: { id: userId } }),
      getContextGeneration: () => authGeneration,
    } as never,
    repository as never,
    targetResolver as never,
    monitor as never,
    () => predictionState,
    resultRepository as never,
  )
  return {
    service,
    repository,
    monitor,
    targetResolver,
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

  it('blocks profile activation while Twitch prediction state is active', async () => {
    const { service, repository, targetResolver } = harness('active')

    await expect(service.activate(SECONDARY_ID, 1)).rejects.toMatchObject({
      code: 'PREDICTIONS_ACTIVE',
    })
    expect(repository.activate).not.toHaveBeenCalled()
    expect(targetResolver.resolveProfile).not.toHaveBeenCalled()
  })

  it('blocks profile activation while Twitch predictions are starting', async () => {
    const { service, repository } = harness('starting')

    await expect(service.activate(SECONDARY_ID, 1)).rejects.toMatchObject({
      code: 'PREDICTIONS_ACTIVE',
    })
    expect(repository.activate).not.toHaveBeenCalled()
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

  it('restarts after deleting the active profile even if result cleanup fails', async () => {
    const resultRepository = {
      delete: vi.fn().mockRejectedValue(new Error('disk cleanup failed')),
    }
    const { service, repository, monitor } = harness('stopped', resultRepository)
    repository.delete.mockImplementation(() => Promise.resolve(status(SECONDARY_ID, 2)))
    repository.list
      .mockResolvedValueOnce(status(PRIMARY_ID, 1))
      .mockResolvedValue(status(SECONDARY_ID, 2))

    await expect(service.delete(PRIMARY_ID, 1)).resolves.toMatchObject({
      profiles: { activeProfileId: SECONDARY_ID },
    })
    expect(resultRepository.delete).toHaveBeenCalledWith('user-1', PRIMARY_ID)
    expect(monitor.restartIfActive).toHaveBeenCalledTimes(1)
  })

  it('rejects source rebinding when the aspect ratio would invalidate regions', async () => {
    const { service, repository } = harness()
    repository.get.mockResolvedValue({
      configuration: { frameSize: { width: 1920, height: 1080 } },
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
})
