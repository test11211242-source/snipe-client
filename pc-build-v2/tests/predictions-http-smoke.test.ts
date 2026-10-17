import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  MonitorProcessEventSchema,
  type MonitorPredictionResultEvent,
  type MonitorTriggeredEvent,
} from '../shared/contracts/monitor-protocol'
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
  it('runs own-battle heartbeat, manual win/loss/skip/refund and a two-win streak against the server', async () => {
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
    let resultListener:
      ((event: MonitorPredictionResultEvent['payload']) => unknown) | null = null
    const monitor = {
      getView: () =>
        Promise.resolve({ state: 'READY', runIntent: true, sourceMinimized: false }),
      subscribeBattleStarts: (listener: typeof battleListener) => {
        battleListener = listener
        return vi.fn()
      },
      subscribePredictionResults: (listener: typeof resultListener) => {
        resultListener = listener
        return vi.fn()
      },
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
    const nextPrediction = (): Promise<number> =>
      vi.waitFor(
        async () => {
          const response = await fetch(`${url.origin}/__smoke/tick`, { method: 'POST' })
          expect(response.ok).toBe(true)
          const next = PredictionStatusSchema.parse(await response.json())
          if (next.prediction === null) throw new Error('No open synthetic prediction')
          return next.prediction.id
        },
        { timeout: 5_000 },
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
      const firstId = await nextPrediction()
      expect(
        await service.execute({
          action: 'predictions.battle',
          predictionId: firstId,
          outcome: 'not_ranked',
          requestId: randomUUID(),
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'PREDICTION_NO_BATTLE_TO_SKIP' },
      })
      expect(service.getView().predictions.prediction).toMatchObject({
        id: firstId,
        source: 'snipe',
        canSettle: true,
      })
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
      const skipIntent = {
        action: 'predictions.battle' as const,
        predictionId: firstId,
        outcome: 'not_ranked' as const,
        requestId: randomUUID(),
      }
      expect(await service.execute(skipIntent)).toMatchObject({ ok: true })
      expect(service.getView().predictions).toMatchObject({
        prediction: { id: firstId, wins: 0 },
        stats: { yes: 0, no: 0 },
      })
      // Retrying the same human intent after an uncertain response must not count a battle.
      expect(await service.execute(skipIntent)).toMatchObject({ ok: true })
      expect(service.getView().predictions.prediction).toMatchObject({ wins: 0 })
      const skippedEvidence = (await (
        await fetch(`${url.origin}/__smoke/evidence`)
      ).json()) as {
        battles: { battle_id: string; outcome: string; outcome_source: string }[]
      }
      expect(skippedEvidence.battles).toContainEqual(
        expect.objectContaining({
          battle_id: battleId,
          outcome: 'not_ranked',
          outcome_source: 'streamer',
        }),
      )
      expect(
        await service.execute({
          action: 'predictions.battle',
          predictionId: firstId,
          outcome: 'win',
          requestId: randomUUID(),
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.stats.yes).toBe(1)

      const lossId = await nextPrediction()
      expect(
        await service.execute({
          action: 'predictions.battle',
          predictionId: lossId,
          outcome: 'loss',
          requestId: randomUUID(),
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
          requestId: randomUUID(),
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
          requestId: randomUUID(),
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

      // A foreign Twitch prediction is adopted, never treated as an own win/loss.
      expect((await fetch(`${url.origin}/__smoke/reset`, { method: 'POST' })).ok).toBe(
        true,
      )
      expect((await fetch(`${url.origin}/__smoke/foreign`, { method: 'POST' })).ok).toBe(
        true,
      )
      coordinator.notifyContextChanged()
      await vi.waitFor(
        async () => {
          const ready = await api.request({
            method: 'GET',
            path: '/api/streamer/predictions/status',
            schema: PredictionStatusSchema,
          })
          expect(ready).toMatchObject({ ok: true, data: { clientReady: true } })
        },
        { timeout: 5_000 },
      )
      const foreignId = await nextPrediction()
      const foreignView = await service.refresh()
      expect(foreignView.predictions.prediction).toMatchObject({
        id: foreignId,
        source: 'twitch',
        canSettle: false,
      })
      const unsafeSettlement = await api.request({
        method: 'POST',
        path: '/api/streamer/predictions/current/battle',
        schema: PredictionStatusSchema,
        body: { predictionId: foreignId, outcome: 'win', requestId: randomUUID() },
      })
      expect(unsafeSettlement).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED', status: 409 },
      })
      expect(
        await service.execute({
          action: 'predictions.cancel',
          predictionId: foreignId,
          confirmed: true,
        }),
      ).toMatchObject({ ok: true })
      expect(service.getView().predictions.stats).toEqual({
        resolved: 0,
        yes: 0,
        no: 0,
        canceled: 1,
      })
      expect(
        service.getView().predictions.history.find((item) => item.id === foreignId),
      ).toMatchObject({ phase: 'canceled', source: 'twitch' })

      // A foreign prediction the streamer resolves on Twitch closes locally as
      // `resolved_external` and is counted in none of the stats.
      expect((await fetch(`${url.origin}/__smoke/reset`, { method: 'POST' })).ok).toBe(
        true,
      )
      expect((await fetch(`${url.origin}/__smoke/foreign`, { method: 'POST' })).ok).toBe(
        true,
      )
      coordinator.notifyContextChanged()
      await vi.waitFor(
        async () => {
          const ready = await api.request({
            method: 'GET',
            path: '/api/streamer/predictions/status',
            schema: PredictionStatusSchema,
          })
          expect(ready).toMatchObject({ ok: true, data: { clientReady: true } })
        },
        { timeout: 5_000 },
      )
      const externalId = await nextPrediction()
      expect((await service.refresh()).predictions.prediction).toMatchObject({
        id: externalId,
        source: 'twitch',
        canSettle: false,
      })
      expect(
        (await fetch(`${url.origin}/__smoke/foreign/resolve`, { method: 'POST' })).ok,
      ).toBe(true)
      // The server re-reads an open prediction from Twitch every 15 seconds.
      await vi.waitFor(
        async () => {
          const response = await fetch(`${url.origin}/__smoke/tick`, { method: 'POST' })
          expect(response.ok).toBe(true)
          const closed = PredictionStatusSchema.parse(await response.json())
          expect(closed.prediction?.id).not.toBe(externalId)
        },
        { timeout: 20_000, interval: 500 },
      )
      const externalView = (await service.refresh()).predictions
      expect(externalView.history.find((item) => item.id === externalId)).toMatchObject({
        phase: 'resolved_external',
        settledBy: 'twitch',
        source: 'twitch',
      })
      expect(externalView.stats).toEqual({ resolved: 0, yes: 0, no: 0, canceled: 0 })

      // A ranked result without a +/- pill must settle through the actual
      // coordinator, HTTP API, database and fake Twitch, without manual input.
      for (const [top, bottom, outcome, phase] of [
        [0, 1, 'win', 'resolved_yes'],
        [1, 0, 'loss', 'resolved_no'],
      ] as const) {
        expect((await fetch(`${url.origin}/__smoke/reset`, { method: 'POST' })).ok).toBe(
          true,
        )
        coordinator.notifyContextChanged()
        await vi.waitFor(
          async () => {
            const ready = await api.request({
              method: 'GET',
              path: '/api/streamer/predictions/status',
              schema: PredictionStatusSchema,
            })
            expect(ready).toMatchObject({ ok: true, data: { clientReady: true } })
          },
          { timeout: 5_000 },
        )
        const automaticId = await nextPrediction()
        const rankedBattleId = randomUUID()
        listener({
          triggerId: rankedBattleId,
          timestamp: new Date().toISOString(),
          kind: 'battle',
          rank: 'pol',
          rankEvidence: { opponent: 'medal', own: 'medal' },
        })
        expect(resultListener).not.toBeNull()
        const deliverResult = resultListener as unknown as (
          event: MonitorPredictionResultEvent['payload'],
        ) => unknown
        deliverResult({
          battleId: rankedBattleId,
          gap: false,
          outcome,
          evidence: { crowns: { top, bottom }, deltaSign: null, deltaIcon: 'absent' },
        })
        await vi.waitFor(
          async () => {
            const resolved = await api.request({
              method: 'GET',
              path: '/api/streamer/predictions/status',
              schema: PredictionStatusSchema,
            })
            if (!resolved.ok) throw new Error(resolved.error.code)
            expect(
              resolved.data.history.find((item) => item.id === automaticId),
            ).toMatchObject({
              phase,
              settledBy: 'screen',
            })
          },
          { timeout: 5_000 },
        )
      }

      const eventsFile = process.env['CR_C3_EVENTS_JSONL']
      if (eventsFile !== undefined) {
        const replayed = readFileSync(eventsFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => MonitorProcessEventSchema.parse(JSON.parse(line)))
          .find(
            (event) =>
              event.type === 'prediction_result' &&
              event.payload.outcome === 'win' &&
              !event.payload.gap &&
              event.payload.evidence.deltaIcon === 'pol',
          )
        if (replayed?.type !== 'prediction_result' || replayed.payload.battleId === null)
          throw new Error('No usable captured C3 win event')
        const capturedResult = replayed.payload
        const capturedBattleId = replayed.payload.battleId
        expect((await fetch(`${url.origin}/__smoke/reset`, { method: 'POST' })).ok).toBe(
          true,
        )
        coordinator.notifyContextChanged()
        await vi.waitFor(
          async () => {
            const ready = await api.request({
              method: 'GET',
              path: '/api/streamer/predictions/status',
              schema: PredictionStatusSchema,
            })
            expect(ready).toMatchObject({ ok: true, data: { clientReady: true } })
          },
          { timeout: 5_000 },
        )
        const automaticId = await nextPrediction()
        // The available VS clips are Cheddar (not_pol), not the ranked battle
        // ending in this result clip. Bind a synthetic own VS with unknown rank;
        // keep the captured C3 result payload completely unchanged.
        listener({
          triggerId: capturedBattleId,
          timestamp: new Date().toISOString(),
          kind: 'battle',
          rank: 'unknown',
          rankEvidence: null,
        })
        expect(resultListener).not.toBeNull()
        const deliverResult = resultListener as unknown as (
          event: MonitorPredictionResultEvent['payload'],
        ) => unknown
        deliverResult(capturedResult)
        await vi.waitFor(
          async () => {
            const resolved = await api.request({
              method: 'GET',
              path: '/api/streamer/predictions/status',
              schema: PredictionStatusSchema,
            })
            if (!resolved.ok) throw new Error(resolved.error.code)
            expect(resolved.data.stats).toEqual({
              resolved: 1,
              yes: 1,
              no: 0,
              canceled: 0,
            })
            expect(
              resolved.data.history.find((item) => item.id === automaticId),
            ).toMatchObject({ phase: 'resolved_yes', settledBy: 'screen' })
          },
          { timeout: 5_000 },
        )
        await vi.waitFor(
          () =>
            expect(logger.info).toHaveBeenCalledWith(
              'prediction.battle_result',
              expect.objectContaining({ code: 'ok', applied: true, finalOutcome: 'win' }),
            ),
          { timeout: 5_000 },
        )
      }
    } finally {
      await coordinator.shutdown()
    }
  }, 60_000)
})
