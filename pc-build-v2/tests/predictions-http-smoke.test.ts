import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { MonitorTriggeredEvent } from '../shared/contracts/monitor-protocol'
import { PredictionStatusSchema } from '../shared/models/streamer'
import { ApiClient, AuthenticatedApiClient } from '../electron/main/services/api-client'
import { PredictionCoordinator } from '../electron/main/services/prediction-coordinator'

const baseUrl = process.env['SNIPE_PREDICTIONS_SMOKE_URL']

// Opt-in integration against the local server worktree with synthetic auth, an
// isolated Docker PostgreSQL schema and the server tests' HTTP fake Helix.
// Never point this fixture at production or a channel with real viewers' bets.
describe.skipIf(baseUrl === undefined)('predictions local HTTP smoke', () => {
  it('sends heartbeat and only own-battle starts through the real API client', async () => {
    const url = new URL(baseUrl ?? '')
    expect(url.hostname).toBe('127.0.0.1')
    const health = await fetch(`${url.origin}/health`)
    expect(await health.json()).toMatchObject({
      fixture: 'real-postgres-fake-helix',
    })
    expect((await fetch(`${url.origin}/__smoke/reset`, { method: 'POST' })).ok).toBe(true)
    const auth = {
      getView: () => ({
        state: 'AUTHENTICATED',
        user: {
          id: 'synthetic-predictions-client',
          role: 'streamer',
          roles: ['streamer'],
        },
        error: null,
      }),
      getContextGeneration: () => 1,
      getAccessToken: () => Promise.resolve('synthetic-client-token'),
      subscribe: vi.fn(() => vi.fn()),
    }
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() }
    const api = new AuthenticatedApiClient(
      new ApiClient({ apiUrl: url.origin } as never, fetch, logger),
      auth,
    )
    let battleListener: ((event: MonitorTriggeredEvent['payload']) => unknown) | null =
      null
    const monitor = {
      getView: () =>
        Promise.resolve({ state: 'READY', runIntent: true, sourceMinimized: false }),
      subscribeBattleStarts: (listener: typeof battleListener) => {
        battleListener = listener
        return vi.fn()
      },
      subscribePredictionResults: vi.fn(() => vi.fn()),
      subscribeViews: vi.fn(() => vi.fn()),
    }
    const captures = {
      getActive: () =>
        Promise.resolve({
          profile: {
            configuration: {
              calibration: {
                coordinateSpace: 'game_relative',
                layouts: [
                  { trigger: { kind: 'vs_edge_orientation', badge: { cy: 0.43 } } },
                ],
              },
            },
          },
        }),
    }
    const coordinator = new PredictionCoordinator(
      auth as never,
      api,
      {} as never,
      monitor as never,
      captures as never,
      undefined,
      logger,
      'synthetic-client-version',
    )
    try {
      coordinator.startLifecycle()
      await vi.waitFor(
        async () => {
          const status = await api.request({
            method: 'GET',
            path: '/api/streamer/predictions/status',
            schema: PredictionStatusSchema,
          })
          expect(status, JSON.stringify(logger.info.mock.calls)).toMatchObject({
            ok: true,
            data: { clientReady: true },
          })
        },
        { timeout: 5_000 },
      )
      const tick = await fetch(`${url.origin}/__smoke/tick`, { method: 'POST' })
      expect(tick.ok).toBe(true)
      const status = PredictionStatusSchema.parse(await tick.json())
      expect(status.prediction).not.toBeNull()
      expect(battleListener).not.toBeNull()
      const listener = battleListener as unknown as (
        event: MonitorTriggeredEvent['payload'],
      ) => unknown
      listener({
        triggerId: randomUUID(),
        timestamp: new Date().toISOString(),
        kind: 'spectate',
        rank: 'unknown',
        rankEvidence: null,
      })
      listener({
        triggerId: randomUUID(),
        timestamp: new Date().toISOString(),
        kind: null,
        rank: 'unknown',
        rankEvidence: null,
      })
      const battleId = randomUUID()
      listener({
        triggerId: battleId,
        timestamp: new Date().toISOString(),
        kind: 'battle',
        rank: 'unknown',
        rankEvidence: null,
      })
      await vi.waitFor(
        async () => {
          const response = await fetch(`${url.origin}/__smoke/evidence`)
          const evidence = (await response.json()) as {
            heartbeatsReady: boolean
            battles: { battle_id: string; kind: string; evidence: string }[]
          }
          expect(evidence.heartbeatsReady).toBe(true)
          expect(evidence.battles).toHaveLength(1)
          expect(evidence.battles[0]).toMatchObject({
            battle_id: battleId,
            kind: 'battle',
          })
          expect(JSON.parse(evidence.battles[0]?.evidence ?? '{}')).toMatchObject({
            vs: { rank: 'unknown' },
          })
        },
        { timeout: 5_000 },
      )
      expect(logger.info).toHaveBeenCalledWith(
        'prediction.battle_start',
        expect.anything(),
      )
    } finally {
      await coordinator.shutdown()
    }
  }, 15_000)
})
