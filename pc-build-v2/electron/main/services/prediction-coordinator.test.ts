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
const legacySettings = {
  predictionType: 'win_lose',
  predictionWindow: 60,
  winStreakCount: 2,
  delayBetweenPredictions: 5,
  autoCreateNext: true,
} as const

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
    else if (input.path.endsWith('/settings') && input.method === 'GET')
      data = DEFAULT_PREDICTION_SETTINGS
    else data = serverStatus
    return Promise.resolve(success(input.schema.parse(data)))
  })
  const captures = {
    getActive: vi.fn(() =>
      Promise.resolve(configuration === null ? null : { profile: { configuration } }),
    ),
  }
  const results = { load: vi.fn() }
  const lifecycle = vi.fn()
  const monitor = {
    getView: vi.fn(() => Promise.resolve(monitorView)),
    start: vi.fn(),
    stop: vi.fn(),
    configurePredictionRuntime: vi.fn(),
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
    results as never,
    monitor as never,
    captures as never,
    lifecycle,
    logger,
    '2.7.0',
  )
  coordinators.push(coordinator)
  coordinator.startLifecycle()
  return {
    coordinator,
    request,
    monitor,
    captures,
    results,
    lifecycle,
    logger,
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
    expect(test.coordinator.state).toBe('active')
    expect(test.results.load).not.toHaveBeenCalled()
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
      expect(test.coordinator.state).toBe('stopped')
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
    expect(test.coordinator.state).toBe('active')
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
    expect(test.calls('battle-result')[0]?.body).toEqual(event)
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

  it('forwards after app/server restarts without requiring local enable and follows server disable', async () => {
    const test = harness()
    expect(test.coordinator.state).toBe('stopped')
    test.battle()
    test.result()
    await flush()
    expect(test.calls('battle-start')).toHaveLength(1)
    expect(test.calls('battle-result')).toHaveLength(1)
    test.setServerStatus(status(false))
    test.coordinator.notifyContextChanged()
    await flush()
    expect(test.coordinator.state).toBe('stopped')
    test.battle(battle({ triggerId: secondBattleId }))
    await flush()
    expect(test.calls('battle-start')).toHaveLength(2)
    test.setServerStatus(status())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(test.coordinator.state).toBe('active')
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
    expect(test.calls('battle-start')).toHaveLength(2)
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
    ['SERVER_ERROR', 503],
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

  it('logs heartbeat and settings load/save outcomes as well as battle calls', async () => {
    const test = harness()
    await flush()
    await test.coordinator.stop()
    expect(test.logger.info).toHaveBeenCalledWith('prediction.heartbeat', {
      code: 'ok',
      attempt: 1,
      status: 200,
    })
    expect(test.logger.info).toHaveBeenCalledWith('prediction.settings_load', {
      code: 'ok',
      attempt: 1,
      status: 200,
    })
    expect(test.logger.info).toHaveBeenCalledWith('prediction.settings_save', {
      code: 'ok',
      attempt: 1,
      status: 200,
    })
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

  it('does not let a heartbeat started during a settings mutation overwrite its result', async () => {
    const test = harness()
    await flush()
    const saving = deferred<ApiResult<unknown>>()
    const heartbeat = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => saving.promise)
    const command = test.coordinator.saveSettings({
      ...DEFAULT_PREDICTION_SETTINGS,
      enabled: false,
    })
    test.request.mockImplementationOnce(() => heartbeat.promise)
    test.coordinator.notifyContextChanged()
    await flush()
    saving.resolve(success(status(false)))
    await command
    heartbeat.resolve(success(status()))
    await flush()
    expect(test.coordinator.state).toBe('stopped')
  })

  it('ignores old-user and pre-mutation observations but follows current server state', async () => {
    const test = harness()
    await flush()
    const stale = test.coordinator.observationGeneration
    await test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS)
    test.coordinator.observeServerState(false, '42', stale)
    test.coordinator.observeServerState(false, '84')
    expect(test.coordinator.state).toBe('active')
    test.coordinator.observeServerState(false, '42')
    expect(test.coordinator.state).toBe('stopped')
    test.coordinator.observeServerState(true, '42')
    expect(test.coordinator.state).toBe('active')
    test.changeAuth('signed_out')
    test.coordinator.observeServerState(true, '42')
    expect(test.coordinator.state).toBe('stopped')
  })

  it('does not send a disable mutation after the settings read changes auth context', async () => {
    const test = harness()
    await flush()
    const pending = deferred<ApiResult<unknown>>()
    test.request.mockImplementationOnce(() => pending.promise)
    const stopping = test.coordinator.stop(true)
    test.changeAuth('streamer', '84')
    pending.resolve(success(DEFAULT_PREDICTION_SETTINGS))
    await stopping
    await flush()
    expect(test.calls('settings').filter((input) => input.method === 'PUT')).toHaveLength(
      0,
    )
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
    expect(test.monitor.configurePredictionRuntime).not.toHaveBeenCalled()
    expect(test.lifecycle).not.toHaveBeenCalled()
    expect(test.request.mock.calls.every(([input]) => input.method === 'POST')).toBe(true)
  })
})

describe('PredictionCoordinator temporary settings bridges', () => {
  it('saves validated server settings and derives state from the returned server view only', async () => {
    const test = harness()
    await flush()
    test.setServerStatus(status(false))
    await test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS)
    expect(test.coordinator.state).toBe('stopped')
    expect(test.calls('settings')[0]).toMatchObject({
      method: 'PUT',
      body: DEFAULT_PREDICTION_SETTINGS,
    })
    test.setServerStatus(status())
    await test.coordinator.start(legacySettings)
    expect(test.calls('settings').at(-1)?.body).toEqual({
      ...DEFAULT_PREDICTION_SETTINGS,
      enabled: true,
      votingSeconds: 60,
      streakLength: 2,
    })
    expect(test.coordinator.state).toBe('active')
    expect(test.monitor.configurePredictionRuntime).not.toHaveBeenCalled()
    expect(test.monitor.start).not.toHaveBeenCalled()
    expect(test.coordinator.suspended).toBe(false)
  })

  it('disables by loading authoritative settings and preserving every non-enabled field', async () => {
    const test = harness()
    await flush()
    const settings = {
      ...DEFAULT_PREDICTION_SETTINGS,
      mode: 'streak' as const,
      streakLength: 7,
      chatProgress: false,
    }
    test.request.mockResolvedValueOnce(success(settings))
    test.setServerStatus(status(false))
    await test.coordinator.stop()
    expect(test.calls('settings').map((input) => input.method)).toEqual(['GET', 'PUT'])
    expect(test.calls('settings')[1]?.body).toEqual({ ...settings, enabled: false })
    expect(test.coordinator.state).toBe('stopped')
    expect(test.monitor.stop).not.toHaveBeenCalled()
  })

  it('does not optimistically change state after a rejected settings mutation', async () => {
    const test = harness()
    await flush()
    test.request.mockResolvedValueOnce(failure('FORBIDDEN', 403))
    await expect(
      test.coordinator.saveSettings({ ...DEFAULT_PREDICTION_SETTINGS, enabled: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(test.coordinator.state).toBe('active')
  })

  it('rejects settings commands without a current streamer context', async () => {
    const test = harness('user')
    await expect(
      test.coordinator.saveSettings(DEFAULT_PREDICTION_SETTINGS),
    ).rejects.toMatchObject({ code: 'STREAMER_ROLE_REQUIRED' })
    await test.coordinator.stop(true)
    expect(test.request).not.toHaveBeenCalled()
  })
})
