import { describe, expect, it, vi } from 'vitest'

import type { MonitorAction } from './monitor-process-service'
import { PredictionCoordinator } from './prediction-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const auth = {
  getContextGeneration: () => 1,
  getView: () => ({
    state: 'AUTHENTICATED',
    user: {
      id: '42',
      username: 'caster',
      email: 'c@example.com',
      role: 'premium',
      roles: ['premium', 'streamer'],
    },
    deviceHint: null,
    error: null,
  }),
}
const configuration = {
  frameSize: { width: 1920, height: 1080 },
  trigger: { x: 0, y: 0, width: 0.2, height: 0.2 },
  data: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
  triggerProfile: {},
}
const settings = {
  predictionType: 'win_lose',
  predictionWindow: 60,
  winStreakCount: 2,
  delayBetweenPredictions: 5,
  autoCreateNext: true,
} as const

function harness(
  failConfigure = false,
  runLifecycle?: (operation: () => Promise<void>) => Promise<void>,
  captureRepository?: object,
  resultConfiguration: object = configuration,
) {
  interface TestRequest {
    path: string
    body?: unknown
  }
  let battleListener: ((timestamp: string) => void) | undefined
  let resultListener: ((action: MonitorAction) => void) | undefined
  let currentUserId = '42'
  let authGeneration = 1
  const authSession = {
    getContextGeneration: () => authGeneration,
    getView: () => ({
      ...auth.getView(),
      user: { ...auth.getView().user, id: currentUserId },
    }),
  }
  const request = vi.fn(({ path }: TestRequest) => {
    if (path.endsWith('/auth/status'))
      return Promise.resolve({
        ok: true as const,
        status: 200,
        data: { connected: true },
      })
    return Promise.resolve({ ok: true as const, status: 200, data: { success: true } })
  })
  const monitor = {
    isRunning: vi.fn().mockReturnValue(true),
    getView: vi.fn().mockResolvedValue({ state: 'READY' }),
    configurePredictionRuntime: failConfigure
      ? vi.fn().mockRejectedValue(new Error('restart failed'))
      : vi.fn().mockResolvedValue({ state: 'READY' }),
    start: vi.fn().mockResolvedValue({ state: 'READY' }),
    stop: vi.fn().mockResolvedValue({ state: 'STOPPED' }),
    subscribeBattleStarts: vi.fn((listener: (timestamp: string) => void) => {
      battleListener = listener
      return vi.fn()
    }),
    subscribePredictionResults: vi.fn((listener: (action: MonitorAction) => void) => {
      resultListener = listener
      return vi.fn()
    }),
  }
  const coordinator = new PredictionCoordinator(
    authSession as never,
    { request } as never,
    { load: vi.fn().mockResolvedValue(resultConfiguration) } as never,
    monitor as never,
    captureRepository as never,
    runLifecycle,
  )
  coordinator.startLifecycle()
  return {
    coordinator,
    request,
    monitor,
    battle: () => battleListener,
    result: () => resultListener,
    changeAuthContext: (userId: string) => {
      currentUserId = userId
      authGeneration += 1
    },
  }
}

describe('PredictionCoordinator', () => {
  it('rolls the server back and exposes failed state when local monitor restart fails', async () => {
    const test = harness(true)
    await expect(test.coordinator.start(settings)).rejects.toMatchObject({
      code: 'PREDICTION_LOCAL_START_FAILED',
    })
    expect(test.request.mock.calls.map(([value]) => value.path)).toContain(
      '/api/streamer/bot/stop',
    )
    expect(test.coordinator.state).toBe('failed')
  })

  it('serializes bounded battle and private result events through main only', async () => {
    const test = harness()
    await test.coordinator.start(settings)
    test.battle()?.('2026-07-12T12:00:00.000Z')
    test.battle()?.('2026-07-12T12:00:01.000Z')
    test.result()?.({
      timestamp: '2026-07-12T12:00:02.000Z',
      width: 1,
      height: 1,
      image: Buffer.from('private-image'),
    })
    await vi.waitFor(() =>
      expect(
        test.request.mock.calls.some(([value]) => value.path.endsWith('/battle-result')),
      ).toBe(true),
    )
    expect(
      test.request.mock.calls.filter(([value]) => value.path.endsWith('/battle-start')),
    ).toHaveLength(1)
    const resultCall = test.request.mock.calls.find(([value]) =>
      value.path.endsWith('/battle-result'),
    )?.[0]
    expect(resultCall?.body).toBeInstanceOf(FormData)
    expect(JSON.stringify(resultCall)).not.toContain('private-image')
  })

  it('recovers after a client restart by stopping an active server from local stopped state', async () => {
    const test = harness()
    await Promise.all([test.coordinator.stop(), test.coordinator.stop()])
    expect(
      test.request.mock.calls.filter(
        ([value]) => value.path === '/api/streamer/bot/stop',
      ),
    ).toHaveLength(1)
    expect(test.monitor.configurePredictionRuntime).not.toHaveBeenCalled()

    await test.coordinator.stop()
    expect(
      test.request.mock.calls.filter(
        ([value]) => value.path === '/api/streamer/bot/stop',
      ),
    ).toHaveLength(2)
  })

  it('cancels a prediction start that was still waiting for the lifecycle lock', async () => {
    const gate = deferred<undefined>()
    const test = harness(false, async (operation) => {
      await gate.promise
      return operation()
    })
    const starting = test.coordinator.start(settings)
    await test.coordinator.stop()
    gate.resolve(undefined)

    await expect(starting).rejects.toMatchObject({ code: 'PREDICTION_CANCELLED' })
    expect(
      test.request.mock.calls.some(([value]) => value.path === '/api/streamer/bot/start'),
    ).toBe(false)
  })

  it('rejects result calibration bound to an older capture configuration', async () => {
    const profileId = '00000000-0000-4000-8000-000000000001'
    const staleResult = {
      ...configuration,
      captureProfileId: profileId,
      captureConfigurationRevision: 1,
      captureConfigurationFingerprint: 'a'.repeat(64),
    }
    const test = harness(
      false,
      undefined,
      {
        list: vi.fn().mockResolvedValue({
          activeProfileId: profileId,
          profiles: [
            {
              profileId,
              configurationRevision: 2,
              configurationFingerprint: 'b'.repeat(64),
            },
          ],
        }),
      },
      staleResult,
    )

    await expect(test.coordinator.start(settings)).rejects.toMatchObject({
      code: 'RESULT_SETUP_REQUIRED',
    })
    expect(
      test.request.mock.calls.some(([value]) => value.path === '/api/streamer/bot/start'),
    ).toBe(false)
  })

  it('does not stop a different user server after an auth transition', async () => {
    const test = harness()
    test.coordinator.observeServerState(true, '42')
    test.changeAuthContext('84')

    await test.coordinator.stop(true)
    expect(
      test.request.mock.calls.some(([value]) => value.path === '/api/streamer/bot/stop'),
    ).toBe(false)
  })

  it('ignores a server observation started before the current prediction command', async () => {
    const test = harness()
    const staleGeneration = test.coordinator.observationGeneration
    await test.coordinator.start(settings)

    test.coordinator.observeServerState(false, '42', staleGeneration)
    test.battle()?.('2026-07-12T12:00:00.000Z')
    await vi.waitFor(() =>
      expect(
        test.request.mock.calls.some(
          ([value]) => value.path === '/api/streamer/bot/battle-start',
        ),
      ).toBe(true),
    )
  })

  it('ignores a server observation captured while prediction start is in progress', async () => {
    const test = harness()
    const serverStart = deferred<{
      ok: true
      status: number
      data: { success: true }
    }>()
    test.request.mockImplementation(({ path }) => {
      if (path.endsWith('/auth/status')) {
        return Promise.resolve({
          ok: true as const,
          status: 200,
          data: { connected: true },
        })
      }
      if (path === '/api/streamer/bot/start') return serverStart.promise
      return Promise.resolve({
        ok: true as const,
        status: 200,
        data: { success: true as const },
      })
    })
    const starting = test.coordinator.start(settings)
    await vi.waitFor(() =>
      expect(
        test.request.mock.calls.some(
          ([value]) => value.path === '/api/streamer/bot/start',
        ),
      ).toBe(true),
    )
    const staleGeneration = test.coordinator.observationGeneration
    serverStart.resolve({ ok: true, status: 200, data: { success: true } })
    await starting

    test.coordinator.observeServerState(false, '42', staleGeneration)
    test.battle()?.('2026-07-12T12:00:00.000Z')
    await vi.waitFor(() =>
      expect(
        test.request.mock.calls.some(
          ([value]) => value.path === '/api/streamer/bot/battle-start',
        ),
      ).toBe(true),
    )
  })
})
