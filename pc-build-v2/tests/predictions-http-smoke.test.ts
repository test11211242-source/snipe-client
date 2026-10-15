import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { MonitorTriggeredEvent } from '../shared/contracts/monitor-protocol'
import {
  DEFAULT_PREDICTION_SETTINGS,
  PredictionStatusSchema,
} from '../shared/models/streamer'
import { ApiClient, AuthenticatedApiClient } from '../electron/main/services/api-client'
import { PredictionCoordinator } from '../electron/main/services/prediction-coordinator'
import { StreamerService } from '../electron/main/services/streamer-service'

const baseUrl = process.env['SNIPE_PREDICTIONS_SMOKE_URL']

// Opt-in integration against the local server worktree with synthetic auth, an
// isolated Docker PostgreSQL schema and the server tests' HTTP fake Helix.
// Never point this fixture at production or a channel with real viewers' bets.
describe.skipIf(baseUrl === undefined)('predictions local HTTP smoke', () => {
  it('runs own-battle heartbeat, manual win/loss/refund and a two-win streak against the server', async () => {
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
      monitor as never,
      captures as never,
      logger,
      'synthetic-client-version',
    )
    const service = new StreamerService(
      auth as never,
      api,
      captures as never,
      monitor as never,
      coordinator,
      { openExternal: vi.fn() },
      { writeText: vi.fn() },
    )
    const nextPrediction = async (): Promise<number> => {
      const response = await fetch(`${url.origin}/__smoke/tick`, { method: 'POST' })
      expect(response.ok).toBe(true)
      const next = PredictionStatusSchema.parse(await response.json())
      if (next.prediction === null) throw new Error('No open synthetic prediction')
      return next.prediction.id
    }
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
      const firstId = status.prediction?.id
      if (firstId === undefined) throw new Error('Missing synthetic prediction')
      expect(
        await service.execute({
          action: 'predictions.battle',
          predictionId: firstId,
          outcome: 'win',
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.stats.yes).toBe(1)

      const lossId = await nextPrediction()
      expect(
        await service.execute({
          action: 'predictions.battle',
          predictionId: lossId,
          outcome: 'loss',
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.stats.no).toBe(1)

      const cancelId = await nextPrediction()
      expect(
        await service.execute({
          action: 'predictions.cancel',
          predictionId: cancelId,
          confirmed: true,
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.stats.canceled).toBe(1)

      const streak = {
        ...DEFAULT_PREDICTION_SETTINGS,
        mode: 'streak' as const,
        streakLength: 2,
      }
      expect(
        await service.execute({
          action: 'predictions.settings.save',
          settings: { ...streak, enabled: false },
        }),
      ).toMatchObject({ ok: true })
      expect(
        await service.execute({
          action: 'predictions.settings.save',
          settings: streak,
        }),
      ).toMatchObject({ ok: true })
      const streakId = await nextPrediction()
      expect(
        await service.execute({
          action: 'predictions.battle',
          predictionId: streakId,
          outcome: 'win',
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.prediction).toMatchObject({
        id: streakId,
        target: 2,
        wins: 1,
      })
      expect(
        await service.execute({
          action: 'predictions.battle',
          predictionId: streakId,
          outcome: 'win',
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.stats.yes).toBe(2)

      const withBetsId = await nextPrediction()
      expect((await fetch(`${url.origin}/__smoke/bets`, { method: 'POST' })).ok).toBe(
        true,
      )
      expect(
        await service.execute({
          action: 'predictions.settings.save',
          settings: { ...streak, enabled: false },
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions).toMatchObject({
        enabled: false,
        attention: 'settle_after_disable',
        prediction: { id: withBetsId, hasBets: true },
      })
      const canceledBefore = service.getView().predictions.stats.canceled
      expect(
        await service.execute({
          action: 'predictions.cancel',
          predictionId: withBetsId,
          confirmed: true,
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.prediction).toBeNull()
      expect(service.getView().predictions.stats.canceled).toBe(canceledBefore + 1)
      const finalEvidence = await fetch(`${url.origin}/__smoke/evidence`)
      expect(await finalEvidence.json()).toMatchObject({ chatMessages: 1 })
    } finally {
      await coordinator.shutdown()
    }
  }, 15_000)
})
