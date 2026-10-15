import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  MonitorPredictionResultEvent,
  MonitorTriggeredEvent,
} from '../../../shared/contracts/monitor-protocol'
import type { ApiErrorCode } from '../../../shared/errors/api-error'
import { ApplicationError } from '../../../shared/errors/application-error'
import type { AuthView } from '../../../shared/models/auth'
import type { CaptureConfiguration } from '../../../shared/models/capture'
import type { MonitorView } from '../../../shared/models/monitor'
import {
  DEFAULT_PREDICTION_SETTINGS,
  type PredictionStatus,
} from '../../../shared/models/streamer'
import type { ApiRequest, ApiResult } from './api-client'
import {
  getPredictionProfileReadiness,
  getPredictionReadiness,
  PredictionCoordinator,
} from './prediction-coordinator'

type BattleStart = MonitorTriggeredEvent['payload']
type PredictionResultEvent = MonitorPredictionResultEvent['payload']
type TestRequest = ApiRequest<unknown> & { authContextGuard?: () => boolean }
const root = '/api/streamer/predictions'
const battleId = '00000000-0000-4000-8000-000000000001'
const secondBattleId = '00000000-0000-4000-8000-000000000002'
const readyMonitor = { state: 'READY', runIntent: true, sourceMinimized: false } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function profile(...centers: number[]): CaptureConfiguration {
  // Only the fields consumed by readiness are needed; persistence validates the full profile.
  return {
    calibration: {
      coordinateSpace: 'game_relative',
      layouts: centers.map((cy) => ({
        trigger: { kind: 'vs_edge_orientation', badge: { cy } },
      })),
    },
  } as unknown as CaptureConfiguration
}

function fullFrameProfile(): CaptureConfiguration {
  return {
    calibration: { coordinateSpace: 'full_frame_normalized' },
  } as CaptureConfiguration
}

function status(enabled = true): PredictionStatus {
  return {
    enabled,
    live: true,
    clientReady: true,
    phase: enabled ? 'voting' : 'disabled',
    attention: null,
    prediction: enabled
      ? {
          id: 1,
          title: 'Выиграю следующий бой?',
          mode: 'each_battle',
          target: 1,
          wins: 0,
          locksAt: '2026-10-15T12:00:30.000Z',
          hasBets: false,
        }
      : null,
    stats: { resolved: 0, yes: 0, no: 0, canceled: 0 },
    history: [],
  }
}

function success(data: unknown): ApiResult<unknown> {
  return { ok: true, status: 200, data }
}

function failure(code: ApiErrorCode, statusCode?: number): ApiResult<unknown> {
  return {
    ok: false,
    error: {
      code,
      message: 'Private upstream diagnostic must not be logged',
      retryable: true,
      status: statusCode ?? null,
    },
  }
}

function battle(overrides: Partial<BattleStart> = {}): BattleStart {
  return {
    triggerId: battleId,
    kind: 'battle',
    timestamp: '2026-10-15T12:00:00.000Z',
    rank: 'unknown',
    rankEvidence: null,
    ...overrides,
  }
}

function result(overrides: Partial<PredictionResultEvent> = {}): PredictionResultEvent {
  return {
    battleId,
    gap: false,
    outcome: 'win',
    evidence: { crowns: { top: 1, bottom: 3 }, deltaSign: '+', deltaIcon: 'pol' },
    ...overrides,
  }
}

const coordinators: PredictionCoordinator[] = []

function harness(initialAuth: 'streamer' | 'user' | 'signed_out' = 'streamer') {
  let currentUserId = '42'
  let generation = 1
  let role = initialAuth
  let authListener: (() => void) | undefined
  let battleListener: ((event: BattleStart) => void) | undefined
  let resultListener: ((event: PredictionResultEvent) => void) | undefined
  let viewListener: ((view: MonitorView) => void) | undefined
  let monitorView = { ...readyMonitor } as Pick<
    MonitorView,
    'state' | 'runIntent' | 'sourceMinimized'
  >
  let configuration: CaptureConfiguration | null = profile(0.4, 0.459)
  let monotonicMs = 0
  let serverStatus = status()
  const disposers: Mock[] = []
  const subscribe = <T>(setListener: (listener: T) => void, listener: T) => {
    setListener(listener)
    const dispose = vi.fn()
    disposers.push(dispose)
    return dispose
  }
  const auth = {
    getContextGeneration: () => generation,
    getView: (): AuthView => ({
      state: role === 'signed_out' ? 'UNAUTHENTICATED' : 'AUTHENTICATED',
      user:
        role === 'signed_out'
          ? null
          : {
              id: currentUserId,
              username: 'caster',
              email: 'caster@example.com',
              role: 'premium',
              roles: role === 'streamer' ? ['premium', 'streamer'] : ['premium'],
            },
      error: null,
    }),
    subscribe: vi.fn((listener: () => void) =>
      subscribe((value) => {
        authListener = value
      }, listener),
    ),
  }
  const request = vi.fn((input: TestRequest): Promise<ApiResult<unknown>> => {
    let data: unknown
    if (input.path.endsWith('/battle-start'))
      data = { accepted: true, reason: 'accepted' }
    else if (input.path.endsWith('/battle-result'))
      data = { applied: true, finalOutcome: 'win', reason: 'applied' }
    else data = serverStatus
    return Promise.resolve(success(input.schema.parse(data)))
  })
  const captures = {
    getActive: vi.fn(() =>
      Promise.resolve(configuration === null ? null : { profile: { configuration } }),
    ),
  }
  const monitor = {
    getView: vi.fn(() => Promise.resolve(monitorView)),
    start: vi.fn(),
    stop: vi.fn(),
    subscribeBattleStarts: vi.fn((listener: (event: BattleStart) => void) =>
      subscribe((value) => {
        battleListener = value
      }, listener),
    ),
    subscribePredictionResults: vi.fn(
      (listener: (event: PredictionResultEvent) => void) =>
        subscribe((value) => {
          resultListener = value
        }, listener),
    ),
    subscribeViews: vi.fn((listener: (view: MonitorView) => void) =>
      subscribe((value) => {
        viewListener = value
      }, listener),
    ),
  }
  const logger = { info: vi.fn() }
  const coordinator = new PredictionCoordinator(
    auth as never,
    { request } as never,
    monitor as never,
    captures as never,
    logger,
    '2.7.0',
    () => monotonicMs,
  )
  coordinators.push(coordinator)
  coordinator.startLifecycle()
  return {
    coordinator,
    request,
    monitor,
    captures,
    logger,
    advanceClock: (milliseconds: number) => {
      monotonicMs += milliseconds
    },
    disposers,
    calls: (suffix: string) =>
      request.mock.calls
        .map(([input]) => input)
        .filter((input) => input.path === `${root}/${suffix}`),
    battle: (event = battle()) => battleListener?.(event),
    result: (event = result()) => resultListener?.(event),
    changeMonitor: (view: Partial<typeof monitorView>) => {
      monitorView = { ...monitorView, ...view }
      viewListener?.(monitorView as MonitorView)
    },
    changeProfile: (next: CaptureConfiguration | null) => {
      configuration = next
      coordinator.notifyContextChanged()
    },
    changeAuth: (nextRole: typeof role, userId = currentUserId, notify = true) => {
      role = nextRole
      currentUserId = userId
      generation += 1
      if (notify) authListener?.()
    },
    notifyAuth: () => authListener?.(),
    setServerStatus: (next: PredictionStatus) => {
      serverStatus = next
    },
  }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.shutdown()
  vi.useRealTimers()
})

describe('prediction readiness', () => {
  it('accepts every own-battle layout without result calibration', () => {
    expect(getPredictionProfileReadiness(profile(0.4, 0.42, 0.459))).toEqual({
      ready: true,
      reason: 'ok',
    })
    expect(getPredictionReadiness(profile(0.42), readyMonitor)).toEqual({
      ready: true,
      reason: 'ok',
    })
  })

  it.each([0.399, 0.46, 0.5, 0.58])(
    'rejects a mixed profile containing badge cy %s',
    (cy) => {
      expect(getPredictionProfileReadiness(profile(0.42, cy))).toEqual({
        ready: false,
        reason: 'profile_not_own_battle',
      })
    },
  )

  it('rejects missing, empty, full-frame and structural profiles', () => {
    expect(getPredictionProfileReadiness(null).reason).toBe('profile_not_own_battle')
    expect(getPredictionProfileReadiness(profile()).reason).toBe('profile_not_own_battle')
    expect(getPredictionProfileReadiness(fullFrameProfile())).toEqual({
      ready: false,
      reason: 'profile_full_frame',
    })
    const structural = profile(0.42)
    if (structural.calibration.coordinateSpace === 'game_relative') {
      const layout = structural.calibration.layouts[0]
      if (layout !== undefined) {
        layout.trigger = {
          kind: 'structural',
          profile: {},
        } as never
      }
    }
    expect(getPredictionProfileReadiness(structural).reason).toBe(
      'profile_not_own_battle',
    )
  })

  it.each([
    { state: 'STOPPED' as const },
    { state: 'STARTING' as const },
    { runIntent: false },
    { sourceMinimized: true },
  ])('requires a continuously available running monitor: %j', (view) => {
    expect(getPredictionReadiness(profile(0.42), { ...readyMonitor, ...view })).toEqual({
      ready: false,
      reason: 'monitor_not_ready',
    })
  })
})

describe('PredictionCoordinator heartbeat', () => {
  it('sends immediately and every 30 seconds without local start or result setup', async () => {
    const test = harness()
    await flush()
    expect(test.calls('heartbeat')).toHaveLength(1)
    expect(test.calls('heartbeat')[0]?.body).toEqual({
      clientVersion: '2.7.0',
      ready: true,
      reason: 'ok',
    })
    expect(test.captures.getActive).toHaveBeenCalledWith('42')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(test.calls('heartbeat')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(test.calls('heartbeat')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(test.calls('heartbeat')).toHaveLength(3)
    test.coordinator.startLifecycle()
    await flush()
    expect(test.calls('heartbeat')).toHaveLength(3)
    expect(test.monitor.subscribeViews).toHaveBeenCalledOnce()
  })

  it('sends immediate readiness changes for monitor, minimization and profile commits', async () => {
    const test = harness()
    await flush()
    test.changeMonitor({ state: 'STARTING' })
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: false,
      reason: 'monitor_not_ready',
    })
    test.changeMonitor({ state: 'READY' })
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: true,
      reason: 'ok',
    })
    test.changeMonitor({ sourceMinimized: true })
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: false,
      reason: 'monitor_not_ready',
    })
    test.changeMonitor({ sourceMinimized: false })
    await flush()
    test.changeProfile(fullFrameProfile())
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: false,
      reason: 'profile_full_frame',
    })
    test.changeProfile(profile(0.42, 0.5))
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: false,
      reason: 'profile_not_own_battle',
    })
    test.changeProfile(profile(0.42))
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: true,
      reason: 'ok',
    })
  })

  it('does not repeat heartbeats for unrelated monitor view notifications', async () => {
    const test = harness()
    await flush()
    test.changeMonitor({})
    await flush()
    const count = test.calls('heartbeat').length
    test.changeMonitor({})
    await flush()
    expect(test.calls('heartbeat')).toHaveLength(count)
  })

  it('reports unavailable capture and monitor reads without breaking the next heartbeat', async () => {
    const test = harness()
    await flush()
    test.captures.getActive.mockRejectedValueOnce(new Error('Private path'))
    test.coordinator.notifyContextChanged()
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: false,
      reason: 'profile_not_own_battle',
    })
    test.monitor.getView.mockRejectedValueOnce(new Error('Private monitor details'))
    test.coordinator.notifyContextChanged()
    await flush()
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: false,
      reason: 'monitor_not_ready',
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(test.calls('heartbeat').at(-1)?.body).toMatchObject({
      ready: true,
      reason: 'ok',
    })
  })

  it.each(['user', 'signed_out'] as const)(
    'only runs for authenticated streamer, initially %s',
    async (role) => {
      const test = harness(role)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(test.request).not.toHaveBeenCalled()
      test.changeAuth('streamer')
      await flush()
      expect(test.calls('heartbeat')).toHaveLength(1)
      test.changeAuth('user')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(test.calls('heartbeat')).toHaveLength(1)
      test.changeAuth('streamer', '84')
      await flush()
      expect(test.calls('heartbeat')).toHaveLength(2)
      expect(test.captures.getActive).toHaveBeenLastCalledWith('84')
    },
  )

  it('replaces an in-flight heartbeat when the profile changes', async () => {
    const test = harness()
    await flush()
    const pending = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => pending.promise)
    test.coordinator.notifyContextChanged()
    await flush()
    const old = test.calls('heartbeat').at(-1)
    expect(old).toBeDefined()
    test.changeProfile(fullFrameProfile())
    await flush()
    expect(old?.signal?.aborted).toBe(true)
    expect(old?.authContextGuard?.()).toBe(false)
    pending.resolve(success(status(false)))
    await flush()
    expect(test.logger.info).toHaveBeenCalledWith('prediction.heartbeat', {
      code: 'AUTH_CANCELLED',
      attempt: 1,
    })
  })
})

describe('PredictionCoordinator event forwarding', () => {
  it.each(['pol', 'not_pol', 'unknown'] as const)(
    'forwards every own VS with rank %s and evidence unchanged',
    async (rank) => {
      const test = harness()
      await flush()
      const rankEvidence = { opponent: 'league', own: 'medal' } as const
      test.battle(battle({ rank, rankEvidence }))
      await flush()
      expect(test.calls('battle-start')).toHaveLength(1)
      expect(test.calls('battle-start')[0]).toMatchObject({
        method: 'POST',
        body: { battleId, kind: 'battle', rank, rankEvidence },
      })
      expect(test.calls('battle-start')[0]?.body).not.toHaveProperty('timestamp')
    },
  )

  it('filters spectate and full-frame events before any server call', async () => {
    const test = harness()
    await flush()
    test.battle(battle({ kind: 'spectate' }))
    test.battle(battle({ kind: null }))
    test.battle()
    await flush()
    expect(test.calls('battle-start')).toHaveLength(1)
    expect(test.calls('battle-start')[0]?.body).toEqual({
      battleId,
      kind: 'battle',
      rank: 'unknown',
      rankEvidence: null,
    })
    expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_start', {
      code: 'skipped',
      reason: 'not_own_battle',
    })
  })

  it.each(['win', 'loss', 'draw', 'unknown'] as const)(
    'forwards JSON %s results and crown counts without images',
    async (outcome) => {
      const test = harness()
      await flush()
      const event = result({ outcome })
      test.result(event)
      await flush()
      expect(test.calls('battle-result')[0]).toMatchObject({
        method: 'POST',
        body: event,
      })
      expect(test.calls('battle-result')[0]?.body).not.toBeInstanceOf(FormData)
      expect(test.calls('battle-result')[0]?.body).not.toHaveProperty('image')
      expect(test.calls('battle-result')[0]?.body).not.toHaveProperty('evidence.crown')
    },
  )

  it('preserves null battle identity, gaps and unreadable evidence for server judgment', async () => {
    const test = harness()
    await flush()
    const event = result({
      battleId: null,
      gap: true,
      outcome: 'unknown',
      evidence: {
        crowns: { top: null, bottom: null },
        deltaSign: null,
        deltaIcon: 'unreadable',
      },
    })
    test.result(event)
    await flush()
    expect(test.calls('battle-result')[0]?.body).toEqual({ ...event, vsAgeMs: 0 })
  })

  it('serializes starts and results while heartbeats remain independent', async () => {
    const test = harness()
    await flush()
    const pending = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => pending.promise)
    test.battle()
    test.result()
    test.battle(battle({ triggerId: secondBattleId }))
    await flush()
    expect(test.calls('battle-start')).toHaveLength(1)
    expect(test.calls('battle-result')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(test.calls('heartbeat')).toHaveLength(2)
    pending.resolve(success({ accepted: true, reason: 'accepted' }))
    await flush()
    expect(test.request.mock.calls.map(([input]) => input.path).slice(-2)).toEqual([
      `${root}/battle-result`,
      `${root}/battle-start`,
    ])
  })

  it('keeps an unsent VS and resends it before the result with its original monotonic age', async () => {
    const test = harness()
    await flush()
    test.request
      .mockResolvedValueOnce(failure('SERVER_ERROR', 503))
      .mockResolvedValueOnce(failure('NETWORK_UNAVAILABLE'))
    test.battle()
    await flush()
    expect(test.calls('battle-start')[0]?.body).toMatchObject({ battleId, vsAgeMs: 0 })
    test.advanceClock(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.calls('battle-start')[1]?.body).toMatchObject({
      battleId,
      vsAgeMs: 2_000,
    })
    test.advanceClock(3_000)
    vi.setSystemTime(new Date('2000-01-01T00:00:00Z'))
    test.result()
    await flush()
    expect(test.request.mock.calls.slice(-2).map(([request]) => request.path)).toEqual([
      `${root}/battle-start`,
      `${root}/battle-result`,
    ])
    expect(test.calls('battle-start')[2]?.body).toMatchObject({
      battleId,
      vsAgeMs: 5_000,
    })
    expect(test.calls('battle-result')[0]?.body).toMatchObject({
      battleId,
      vsAgeMs: 5_000,
    })
  })

  it('still sends a result if replaying its unsent VS fails twice again', async () => {
    const test = harness()
    await flush()
    for (let attempt = 0; attempt < 4; attempt += 1)
      test.request.mockResolvedValueOnce(failure('SERVER_ERROR', 503))
    test.battle()
    await flush()
    test.advanceClock(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    test.result()
    await flush()
    test.advanceClock(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.calls('battle-start')).toHaveLength(4)
    expect(test.calls('battle-result')[0]?.body).toMatchObject({
      battleId,
      vsAgeMs: 4_000,
    })
  })

  it('caps monotonic VS age at the server limit on both reports', async () => {
    const test = harness()
    await flush()
    test.request
      .mockResolvedValueOnce(failure('REQUEST_TIMEOUT'))
      .mockResolvedValueOnce(failure('REQUEST_TIMEOUT'))
    test.battle()
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    test.advanceClock(90_000_000)
    // The current battle remains available even past the age cap; no wall clock is used.
    test.result()
    await flush()
    expect(test.calls('battle-start')[2]?.body).toMatchObject({
      battleId,
      vsAgeMs: 86_400_000,
    })
    expect(test.calls('battle-result')[0]?.body).toMatchObject({
      battleId,
      vsAgeMs: 86_400_000,
    })
  })

  it('retains each failed VS identity instead of binding its result to a newer battle', async () => {
    const test = harness()
    await flush()
    test.request
      .mockResolvedValueOnce(failure('REQUEST_TIMEOUT'))
      .mockResolvedValueOnce(failure('REQUEST_TIMEOUT'))
    test.battle()
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    test.advanceClock(10_000)
    test.battle(battle({ triggerId: secondBattleId }))
    await flush()
    test.advanceClock(5_000)
    test.result()
    await flush()
    expect(test.calls('battle-start').map((request) => request.body)).toMatchObject([
      { battleId },
      { battleId },
      { battleId: secondBattleId, vsAgeMs: 0 },
      { battleId, vsAgeMs: 15_000 },
    ])
    expect(test.calls('battle-result')[0]?.body).toMatchObject({
      battleId,
      vsAgeMs: 15_000,
    })
  })

  it('clears a failed VS on auth change and never resends another user’s observation', async () => {
    const test = harness()
    await flush()
    test.request
      .mockResolvedValueOnce(failure('REQUEST_TIMEOUT'))
      .mockResolvedValueOnce(failure('REQUEST_TIMEOUT'))
    test.battle()
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    test.changeAuth('streamer', '84')
    await flush()
    test.result()
    await flush()
    expect(test.calls('battle-start')).toHaveLength(2)
    expect(test.calls('battle-result')[0]?.body).toMatchObject({ battleId, vsAgeMs: 0 })
  })

  it('forwards after app/server restarts whatever the server enabled flag says', async () => {
    const test = harness()
    test.setServerStatus(status(false))
    test.battle()
    test.result()
    await flush()
    expect(test.calls('battle-start')).toHaveLength(1)
    expect(test.calls('battle-result')).toHaveLength(1)
    test.coordinator.notifyContextChanged()
    await flush()
    test.battle(battle({ triggerId: secondBattleId }))
    await flush()
    expect(test.calls('battle-start')).toHaveLength(2)
  })
})

describe('PredictionCoordinator retry and logging', () => {
  it.each(['battle-start', 'battle-result'] as const)(
    'retries %s once after exactly two seconds on network failure',
    async (suffix) => {
      const test = harness()
      await flush()
      test.request.mockResolvedValueOnce(failure('NETWORK_UNAVAILABLE'))
      if (suffix === 'battle-start') test.battle()
      else test.result()
      await flush()
      expect(test.calls(suffix)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(test.calls(suffix)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(test.calls(suffix)).toHaveLength(2)
      expect(test.calls(suffix)[1]?.body).toEqual(test.calls(suffix)[0]?.body)
      const operation = suffix.replace('-', '_')
      expect(test.logger.info).toHaveBeenCalledWith(`prediction.${operation}`, {
        code: 'NETWORK_UNAVAILABLE',
        attempt: 1,
      })
      expect(test.logger.info).toHaveBeenCalledWith(
        `prediction.${operation}`,
        expect.objectContaining({ code: 'ok', attempt: 2 }),
      )
      await vi.advanceTimersByTimeAsync(5_000)
      expect(test.calls(suffix)).toHaveLength(2)
    },
  )

  it.each(['battle-start', 'battle-result'] as const)(
    'retries idempotent %s once on HTTP 5xx',
    async (suffix) => {
      for (const statusCode of [500, 502, 503, 504, 599]) {
        const test = harness()
        await flush()
        test.request.mockResolvedValueOnce(failure('SERVER_ERROR', statusCode))
        if (suffix === 'battle-start') test.battle()
        else test.result()
        await flush()
        expect(test.calls(suffix)).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1_999)
        expect(test.calls(suffix)).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(test.calls(suffix)).toHaveLength(2)
        expect(test.calls(suffix)[1]?.body).toEqual(test.calls(suffix)[0]?.body)
        await test.coordinator.shutdown()
      }
    },
  )

  it.each(['settings', 'heartbeat', 'current/battle', 'current/cancel'] as const)(
    'does not broaden %s retries to HTTP 5xx',
    async (suffix) => {
      const test = harness()
      await flush()
      const before = test.calls(suffix).length
      test.request.mockResolvedValueOnce(failure('SERVER_ERROR', 503))
      if (suffix === 'heartbeat') test.coordinator.notifyContextChanged()
      else {
        const command =
          suffix === 'settings'
            ? test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS)
            : suffix === 'current/battle'
              ? test.coordinator.manualBattle(1, 'win')
              : test.coordinator.cancel(1)
        await expect(command).rejects.toMatchObject({ code: 'SERVER_ERROR' })
      }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(test.calls(suffix)).toHaveLength(before + 1)
    },
  )
  it('retries transport timeouts once, then releases the queue after a second failure', async () => {
    const test = harness()
    await flush()
    test.request
      .mockResolvedValueOnce(failure('REQUEST_TIMEOUT'))
      .mockResolvedValueOnce(failure('NETWORK_UNAVAILABLE'))
    test.battle()
    test.result()
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.calls('battle-start')).toHaveLength(3)
    expect(test.calls('battle-result')).toHaveLength(1)
    expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_start', {
      code: 'NETWORK_UNAVAILABLE',
      attempt: 2,
    })
  })

  it.each([
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['VALIDATION_FAILED', 422],
    ['INVALID_RESPONSE', 200],
  ] as const)(
    'does not retry %s even when marked retryable',
    async (code, statusCode) => {
      const test = harness()
      await flush()
      test.request.mockResolvedValueOnce(failure(code, statusCode))
      test.battle()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(test.calls('battle-start')).toHaveLength(1)
      expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_start', {
        code,
        attempt: 1,
        status: statusCode,
      })
    },
  )

  it('logs thrown failures without private exception text and continues processing', async () => {
    const test = harness()
    await flush()
    test.request.mockRejectedValueOnce(new Error('Private token and image bytes'))
    test.battle()
    test.result()
    await flush()
    expect(test.calls('battle-start')).toHaveLength(1)
    expect(test.calls('battle-result')).toHaveLength(1)
    expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_start', {
      code: 'UNKNOWN',
      attempt: 1,
    })
    test.request.mockRejectedValueOnce(
      new ApplicationError('FORBIDDEN', 'Private auth details'),
    )
    test.battle()
    await flush()
    expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_start', {
      code: 'FORBIDDEN',
      attempt: 1,
    })
    expect(JSON.stringify(test.logger.info.mock.calls)).not.toContain('Private')
  })

  it('logs accepted, ignored and applied server codes without payloads or identities', async () => {
    const test = harness()
    await flush()
    test.request.mockResolvedValueOnce(
      success({ accepted: false, reason: 'duplicate_battle' }),
    )
    test.battle()
    await flush()
    test.request.mockResolvedValueOnce(
      success({ applied: false, finalOutcome: 'unknown', reason: 'result_unknown' }),
    )
    test.result()
    await flush()
    expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_start', {
      code: 'ok',
      attempt: 1,
      status: 200,
      accepted: false,
      reason: 'duplicate_battle',
    })
    expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_result', {
      code: 'ok',
      attempt: 1,
      status: 200,
      applied: false,
      finalOutcome: 'unknown',
      reason: 'result_unknown',
    })
    const logs = JSON.stringify(test.logger.info.mock.calls)
    for (const privateField of [
      battleId,
      'caster',
      'crowns',
      'deltaSign',
      'clientVersion',
    ])
      expect(logs).not.toContain(privateField)
  })

  it('logs heartbeat, settings, manual battle and cancel outcomes as codes only', async () => {
    const test = harness()
    await flush()
    await test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS)
    await test.coordinator.manualBattle(1, 'win')
    await test.coordinator.cancel(1)
    for (const operation of ['heartbeat', 'settings_save', 'manual_battle', 'cancel'])
      expect(test.logger.info).toHaveBeenCalledWith(`prediction.${operation}`, {
        code: 'ok',
        attempt: 1,
        status: 200,
      })
    const logs = JSON.stringify(test.logger.info.mock.calls)
    for (const privateField of ['Выиграю', 'caster', 'clientVersion', 'votingSeconds'])
      expect(logs).not.toContain(privateField)
  })
})

describe('PredictionCoordinator auth isolation and lifecycle', () => {
  it('drops queued events on account switch and never retries under the new account', async () => {
    const test = harness()
    await flush()
    const pending = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => pending.promise)
    test.battle()
    test.result()
    await flush()
    const oldRequest = test.calls('battle-start')[0]
    expect(oldRequest).toBeDefined()
    test.changeAuth('streamer', '84')
    await flush()
    expect(oldRequest?.signal?.aborted).toBe(true)
    expect(oldRequest?.authContextGuard?.()).toBe(false)
    pending.resolve(failure('NETWORK_UNAVAILABLE'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.calls('battle-start')).toHaveLength(1)
    expect(test.calls('battle-result')).toHaveLength(0)
    test.battle(battle({ triggerId: secondBattleId }))
    await flush()
    expect(test.calls('battle-start')).toHaveLength(2)
    expect(test.calls('battle-start')[1]?.authContextGuard?.()).toBe(true)
  })

  it('cancels a pending retry on logout and logs dropped unauthenticated events', async () => {
    const test = harness()
    await flush()
    test.request.mockResolvedValueOnce(failure('NETWORK_UNAVAILABLE'))
    test.battle()
    await flush()
    test.changeAuth('signed_out')
    test.result()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.calls('battle-start')).toHaveLength(1)
    expect(test.calls('battle-result')).toHaveLength(0)
    expect(test.logger.info).toHaveBeenCalledWith('prediction.battle_result', {
      code: 'skipped',
      reason: 'auth_context_changed',
    })
  })

  it('rejects stale same-user requests even before an auth subscriber runs', async () => {
    const test = harness()
    await flush()
    const old = test.calls('heartbeat')[0]
    expect(old).toBeDefined()
    test.changeAuth('streamer', '42', false)
    expect(old?.authContextGuard?.()).toBe(false)
    test.battle()
    await flush()
    expect(test.calls('battle-start')).toHaveLength(0)
    test.notifyAuth()
    await flush()
    expect(test.calls('heartbeat')).toHaveLength(2)
  })

  it('cancels an in-flight manual battle on account switch and never resends it', async () => {
    const test = harness()
    await flush()
    const pending = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => pending.promise)
    const command = test.coordinator.manualBattle(1, 'win')
    const sent = test.calls('current/battle')[0]
    expect(sent).toBeDefined()
    test.changeAuth('streamer', '84')
    expect(sent?.signal?.aborted).toBe(true)
    expect(sent?.authContextGuard?.()).toBe(false)
    pending.resolve(success(status()))
    await expect(command).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.calls('current/battle')).toHaveLength(1)
    expect(test.logger.info).toHaveBeenCalledWith('prediction.manual_battle', {
      code: 'AUTH_CANCELLED',
      attempt: 1,
    })
  })

  it('rejects a settings save whose response arrives after logout', async () => {
    const test = harness()
    await flush()
    const pending = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => pending.promise)
    const saving = test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS)
    test.changeAuth('signed_out')
    pending.resolve(success(status()))
    await expect(saving).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.calls('settings')).toHaveLength(1)
  })

  it('cleans subscriptions and timers without server mutation or monitor lifecycle calls', async () => {
    const test = harness()
    await flush()
    const pending = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => pending.promise)
    test.battle()
    test.result()
    await flush()
    const activeRequest = test.calls('battle-start')[0]
    expect(activeRequest).toBeDefined()
    const count = test.request.mock.calls.length
    await test.coordinator.shutdown()
    expect(activeRequest?.signal?.aborted).toBe(true)
    pending.resolve(success({ accepted: true, reason: 'accepted' }))
    test.coordinator.notifyContextChanged()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.request).toHaveBeenCalledTimes(count)
    expect(test.disposers).toHaveLength(4)
    for (const dispose of test.disposers) expect(dispose).toHaveBeenCalledOnce()
    expect(test.monitor.start).not.toHaveBeenCalled()
    expect(test.monitor.stop).not.toHaveBeenCalled()
    expect(test.request.mock.calls.every(([input]) => input.method === 'POST')).toBe(true)
  })
})

describe('PredictionCoordinator server commands', () => {
  const settled: PredictionStatus = {
    ...status(),
    stats: { resolved: 1, yes: 1, no: 0, canceled: 0 },
  }

  it('saves settings with one PUT and returns the authoritative server status', async () => {
    const test = harness()
    await flush()
    test.setServerStatus(status(false))
    const settings = { ...DEFAULT_PREDICTION_SETTINGS, enabled: false }
    await expect(test.coordinator.saveSettings(settings)).resolves.toEqual(status(false))
    expect(test.calls('settings')).toHaveLength(1)
    expect(test.calls('settings')[0]).toMatchObject({ method: 'PUT', timeoutMs: 15_000 })
    expect(test.calls('settings')[0]?.body).toEqual(settings)
    expect(test.monitor.start).not.toHaveBeenCalled()
    expect(test.monitor.stop).not.toHaveBeenCalled()
  })

  it.each(['win', 'loss'] as const)(
    'sends manual %s as exact JSON and returns the server status',
    async (outcome) => {
      const test = harness()
      await flush()
      test.setServerStatus(settled)
      await expect(test.coordinator.manualBattle(1, outcome)).resolves.toEqual(settled)
      expect(test.calls('current/battle')).toHaveLength(1)
      expect(test.calls('current/battle')[0]).toMatchObject({
        method: 'POST',
        timeoutMs: 15_000,
      })
      expect(test.calls('current/battle')[0]?.body).toEqual({ predictionId: 1, outcome })
    },
  )

  it('sends cancel as exact JSON and returns the server status', async () => {
    const test = harness()
    await flush()
    test.setServerStatus(settled)
    await expect(test.coordinator.cancel(7)).resolves.toEqual(settled)
    expect(test.calls('current/cancel')).toHaveLength(1)
    expect(test.calls('current/cancel')[0]).toMatchObject({ method: 'POST' })
    expect(test.calls('current/cancel')[0]?.body).toEqual({ predictionId: 7 })
  })

  it('validates every command response with the strict status schema', async () => {
    const test = harness()
    await flush()
    await test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS)
    await test.coordinator.manualBattle(1, 'win')
    await test.coordinator.cancel(1)
    for (const suffix of ['settings', 'current/battle', 'current/cancel', 'heartbeat']) {
      const schema = test.calls(suffix)[0]?.schema
      expect(schema?.safeParse(status()).success).toBe(true)
      for (const legacy of [
        { active: true },
        { state: 'active' },
        { statistics: {} },
        { requirements: {} },
        { settings: DEFAULT_PREDICTION_SETTINGS },
      ])
        expect(schema?.safeParse({ ...status(), ...legacy }).success).toBe(false)
    }
  })

  it.each([
    ['current/battle', 'manual_battle', 'NETWORK_UNAVAILABLE'],
    ['current/battle', 'manual_battle', 'REQUEST_TIMEOUT'],
    ['current/cancel', 'cancel', 'NETWORK_UNAVAILABLE'],
    ['current/cancel', 'cancel', 'REQUEST_TIMEOUT'],
  ] as const)(
    'never resends %s after a lost response (%s, %s)',
    async (suffix, operation, code) => {
      const test = harness()
      await flush()
      test.request.mockResolvedValueOnce(failure(code))
      const command =
        operation === 'manual_battle'
          ? test.coordinator.manualBattle(1, 'win')
          : test.coordinator.cancel(1)
      await expect(command).rejects.toMatchObject({ code })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(test.calls(suffix)).toHaveLength(1)
      expect(test.logger.info).toHaveBeenCalledWith(`prediction.${operation}`, {
        code,
        attempt: 1,
      })
      expect(test.logger.info).not.toHaveBeenCalledWith(
        `prediction.${operation}`,
        expect.objectContaining({ attempt: 2 }),
      )
    },
  )

  it('never resends a manual battle after a thrown transport failure or conflict', async () => {
    const test = harness()
    await flush()
    test.request.mockRejectedValueOnce(new Error('Private socket hang up after send'))
    await expect(test.coordinator.manualBattle(1, 'win')).rejects.toMatchObject({
      code: 'UNKNOWN',
    })
    test.request.mockResolvedValueOnce(failure('VALIDATION_FAILED', 409))
    await expect(test.coordinator.manualBattle(1, 'loss')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.calls('current/battle')).toHaveLength(2)
    expect(test.logger.info).toHaveBeenCalledWith('prediction.manual_battle', {
      code: 'VALIDATION_FAILED',
      attempt: 1,
      status: 409,
    })
    expect(JSON.stringify(test.logger.info.mock.calls)).not.toContain('Private')
  })

  it('retries an idempotent settings save once after exactly two seconds', async () => {
    const test = harness()
    await flush()
    test.request.mockResolvedValueOnce(failure('NETWORK_UNAVAILABLE'))
    const saving = test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS)
    await flush()
    expect(test.calls('settings')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(test.calls('settings')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(saving).resolves.toEqual(status())
    expect(test.calls('settings')).toHaveLength(2)
    expect(test.calls('settings')[1]?.body).toEqual(test.calls('settings')[0]?.body)
    expect(test.logger.info).toHaveBeenCalledWith('prediction.settings_save', {
      code: 'ok',
      attempt: 2,
      status: 200,
    })
  })

  it('does not retry a rejected settings save', async () => {
    const test = harness()
    await flush()
    test.request.mockResolvedValueOnce(failure('FORBIDDEN', 403))
    await expect(
      test.coordinator.saveSettings({ ...DEFAULT_PREDICTION_SETTINGS, enabled: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(test.calls('settings')).toHaveLength(1)
  })

  it('sends a manual command at once even while a battle event awaits its retry', async () => {
    const test = harness()
    await flush()
    test.request.mockResolvedValueOnce(failure('NETWORK_UNAVAILABLE'))
    test.battle()
    await flush()
    await test.coordinator.manualBattle(1, 'win')
    expect(test.calls('current/battle')).toHaveLength(1)
    expect(test.calls('battle-start')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(test.calls('battle-start')).toHaveLength(2)
  })

  it('rejects invalid command input before any request', async () => {
    const test = harness()
    await flush()
    const count = test.request.mock.calls.length
    await expect(test.coordinator.manualBattle(0, 'win')).rejects.toThrow()
    await expect(test.coordinator.manualBattle(1.5, 'win')).rejects.toThrow()
    await expect(test.coordinator.manualBattle(1, 'draw' as never)).rejects.toThrow()
    await expect(test.coordinator.cancel(-1)).rejects.toThrow()
    await expect(
      test.coordinator.saveSettings({
        ...DEFAULT_PREDICTION_SETTINGS,
        streakFrom: 6,
        streakTo: 5,
      }),
    ).rejects.toThrow()
    expect(test.request).toHaveBeenCalledTimes(count)
  })

  it('rejects every command without a current streamer context', async () => {
    const test = harness('user')
    for (const command of [
      () => test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS),
      () => test.coordinator.manualBattle(1, 'win'),
      () => test.coordinator.cancel(1),
    ])
      await expect(command()).rejects.toMatchObject({ code: 'STREAMER_ROLE_REQUIRED' })
    expect(test.request).not.toHaveBeenCalled()
  })
})
