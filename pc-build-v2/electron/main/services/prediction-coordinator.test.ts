import { describe, expect, it, vi } from 'vitest'

import type { MonitorAction } from './monitor-process-service'
import { PredictionCoordinator } from './prediction-coordinator'

const auth = {
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

function harness(failConfigure = false) {
  interface TestRequest {
    path: string
    body?: unknown
  }
  let battleListener: ((timestamp: string) => void) | undefined
  let resultListener: ((action: MonitorAction) => void) | undefined
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
    auth as never,
    { request } as never,
    { load: vi.fn().mockResolvedValue(configuration) } as never,
    monitor as never,
  )
  coordinator.startLifecycle()
  return {
    coordinator,
    request,
    monitor,
    battle: () => battleListener,
    result: () => resultListener,
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
})
