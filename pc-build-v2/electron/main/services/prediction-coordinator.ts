import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'
import { hasStreamerRole } from '../../../shared/models/auth'
import type { PredictionRuntimeProfile } from '../../../shared/models/prediction-result'
import type { PredictionPreferences } from '../../../shared/models/streamer'
import type { PredictionResultConfigurationRepository } from '../infrastructure/prediction-result-configuration-repository'
import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { AuthSession } from './auth-session'
import type { AuthenticatedApiClient } from './api-client'
import type { MonitorAction } from './monitor-process-service'
import type { MonitorSupervisor } from './monitor-supervisor'

const SuccessSchema = z.object({ success: z.literal(true) }).loose()
const TwitchSchema = z
  .object({ connected: z.boolean(), success: z.boolean().optional() })
  .loose()

export type PredictionRuntimeState =
  'stopped' | 'starting' | 'active' | 'failed' | 'unknown'

export class PredictionCoordinator {
  #state: PredictionRuntimeState = 'stopped'
  #generation = 0
  #eventQueue: Promise<void> = Promise.resolve()
  #eventController = new AbortController()
  #pendingBattle = false
  #pendingResult: MonitorAction | null = null
  #monitorOwned = false
  #stopPromise: Promise<void> | null = null
  #disposeBattle: (() => void) | null = null
  #disposeResult: (() => void) | null = null

  constructor(
    private readonly auth: AuthSession,
    private readonly api: AuthenticatedApiClient,
    private readonly results: PredictionResultConfigurationRepository,
    private readonly monitor: MonitorSupervisor,
    private readonly captures?: CaptureConfigurationRepository,
    private readonly runLifecycle: (operation: () => Promise<void>) => Promise<void> = (
      operation,
    ) => operation(),
  ) {}

  get state(): PredictionRuntimeState {
    return this.#state
  }

  observeServerState(active: boolean): void {
    if (active && this.#state === 'stopped') this.#state = 'unknown'
    else if (!active && this.#state === 'unknown' && !this.#monitorOwned)
      this.#state = 'stopped'
  }

  startLifecycle(): void {
    if (this.#disposeBattle !== null) return
    this.#disposeBattle = this.monitor.subscribeBattleStarts(() =>
      this.enqueueBattleStart(),
    )
    this.#disposeResult = this.monitor.subscribePredictionResults((action) =>
      this.enqueueResult(action),
    )
  }

  start(settings: PredictionPreferences): Promise<void> {
    const generation = ++this.#generation
    return this.runLifecycle(() => {
      if (generation !== this.#generation) {
        throw new ApplicationError(
          'PREDICTION_CANCELLED',
          'Prediction start was cancelled',
        )
      }
      return this.performStart(settings, generation)
    })
  }

  private async performStart(
    settings: PredictionPreferences,
    generation: number,
  ): Promise<void> {
    this.#eventController.abort()
    this.#eventController = new AbortController()
    const view = this.auth.getView()
    if (!hasStreamerRole(view) || view.user === null) {
      throw new ApplicationError('STREAMER_ROLE_REQUIRED', 'Streamer role is required')
    }
    const userId = view.user.id
    this.#state = 'starting'
    try {
      const configurationRequest =
        this.captures === undefined
          ? this.results.load(userId)
          : this.captures
              .list(userId)
              .then((profiles) =>
                profiles === null
                  ? null
                  : this.results.load(userId, profiles.activeProfileId),
              )
      const [configuration, twitch] = await Promise.all([
        configurationRequest,
        this.api.request({
          method: 'GET',
          path: '/api/streamer/auth/status',
          schema: TwitchSchema,
          signal: this.#eventController.signal,
        }),
      ])
      if (generation !== this.#generation) {
        throw new ApplicationError(
          'PREDICTION_CANCELLED',
          'Prediction start was cancelled',
        )
      }
      if (configuration === null) {
        throw new ApplicationError(
          'RESULT_SETUP_REQUIRED',
          'Configure result trigger and data areas first',
        )
      }
      if (!twitch.ok || !twitch.data.connected) {
        throw new ApplicationError(
          'TWITCH_REQUIRED',
          'Connect Twitch before starting predictions',
        )
      }

      const started = await this.api.request({
        method: 'POST',
        path: '/api/streamer/bot/start',
        body: {
          prediction_type: settings.predictionType,
          prediction_window: settings.predictionWindow,
          win_streak_count: settings.winStreakCount,
          delay_between_predictions: settings.delayBetweenPredictions,
          auto_create_next: settings.autoCreateNext,
        },
        schema: SuccessSchema,
        signal: this.#eventController.signal,
      })
      if (!started.ok) {
        throw new ApplicationError('PREDICTION_START_FAILED', started.error.message)
      }
      if (generation !== this.#generation) {
        await this.stopServer().catch(() => false)
        throw new ApplicationError(
          'PREDICTION_CANCELLED',
          'Prediction start was cancelled',
        )
      }
      const profile: PredictionRuntimeProfile = {
        configuredFrameSize: configuration.frameSize,
        trigger: configuration.trigger,
        data: configuration.data,
        triggerProfile: configuration.triggerProfile,
      }
      const monitorBefore = await this.monitor.getView()
      const wasRunning = ['PREFLIGHT', 'STARTING', 'READY'].includes(monitorBefore.state)
      try {
        const configured = await this.monitor.configurePredictionRuntime(profile)
        if (wasRunning && configured.state !== 'READY') {
          throw new Error('monitor restart did not become ready')
        }
        if (!wasRunning) {
          const monitorView = await this.monitor.start()
          if (monitorView.state !== 'READY')
            throw new Error('monitor did not become ready')
        }
        if (generation !== this.#generation)
          throw new Error('prediction start became stale')
        this.#monitorOwned = !wasRunning
        this.#state = 'active'
      } catch (error) {
        const rollback = await this.stopServer().catch(() => false)
        await this.monitor.configurePredictionRuntime(null).catch(() => undefined)
        if (generation !== this.#generation) {
          this.#state = 'stopped'
          throw new ApplicationError(
            'PREDICTION_CANCELLED',
            'Prediction start was cancelled',
            { cause: error },
          )
        }
        this.#state = rollback ? 'failed' : 'unknown'
        throw new ApplicationError(
          rollback ? 'PREDICTION_LOCAL_START_FAILED' : 'PREDICTION_ROLLBACK_UNKNOWN',
          rollback
            ? 'Predictions were stopped because the local monitor could not restart'
            : 'Local monitor failed and server rollback could not be confirmed',
          { cause: error },
        )
      }
    } catch (error) {
      this.resetStartingState(generation)
      throw error
    }
  }

  private resetStartingState(generation: number): void {
    if (generation === this.#generation && this.#state === 'starting') {
      this.#state = 'stopped'
    }
  }

  stop(bestEffort = false): Promise<void> {
    if (this.#stopPromise !== null) {
      return bestEffort ? this.#stopPromise.catch(() => undefined) : this.#stopPromise
    }
    const operation = this.performStop(bestEffort).finally(() => {
      if (this.#stopPromise === operation) this.#stopPromise = null
    })
    this.#stopPromise = operation
    return operation
  }

  private async performStop(bestEffort: boolean): Promise<void> {
    ++this.#generation
    this.#eventController.abort()
    const locallyStopped = this.#state === 'stopped' && !this.#monitorOwned
    const serverStopped = await this.stopServer().catch(() => false)
    this.#pendingBattle = false
    this.#pendingResult = null
    if (locallyStopped) {
      this.#state = serverStopped || bestEffort ? 'stopped' : 'unknown'
      if (!serverStopped && !bestEffort) {
        throw new ApplicationError(
          'PREDICTION_STOP_UNKNOWN',
          'The server did not confirm prediction stop',
        )
      }
      return
    }
    const wasRunning = this.monitor.isRunning()
    try {
      if (this.#monitorOwned) {
        await this.monitor.stop()
        await this.monitor.configurePredictionRuntime(null)
      } else {
        const configured = await this.monitor.configurePredictionRuntime(null)
        if (wasRunning && configured.state !== 'READY') {
          throw new ApplicationError(
            'PREDICTION_MONITOR_RESTART_FAILED',
            'Monitor could not restart without the prediction profile',
          )
        }
      }
      this.#monitorOwned = false
      this.#state = serverStopped || bestEffort ? 'stopped' : 'unknown'
    } catch (error) {
      this.#state = 'failed'
      if (!bestEffort) throw error
    }
    if (!serverStopped && !bestEffort) {
      throw new ApplicationError(
        'PREDICTION_STOP_UNKNOWN',
        'The server did not confirm prediction stop',
      )
    }
  }

  async shutdown(): Promise<void> {
    this.#disposeBattle?.()
    this.#disposeResult?.()
    this.#disposeBattle = null
    this.#disposeResult = null
    await Promise.race([
      this.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ])
  }

  private async stopServer(): Promise<boolean> {
    const result = await this.api.request({
      method: 'POST',
      path: '/api/streamer/bot/stop',
      schema: SuccessSchema,
      timeoutMs: 10_000,
    })
    if (!result.ok) return result.error.status === 404
    return true
  }

  private enqueueBattleStart(): void {
    if (this.#state !== 'active' || this.#pendingBattle) return
    this.#pendingBattle = true
    const generation = this.#generation
    this.#eventQueue = this.#eventQueue
      .then(async () => {
        this.#pendingBattle = false
        if (generation !== this.#generation || this.#state !== 'active') return
        await this.api.request({
          method: 'POST',
          path: '/api/streamer/bot/battle-start',
          schema: SuccessSchema,
          timeoutMs: 15_000,
          signal: this.#eventController.signal,
        })
      })
      .catch(() => undefined)
  }

  private enqueueResult(action: MonitorAction): void {
    if (this.#state !== 'active') return
    this.#pendingResult = action
    const generation = this.#generation
    this.#eventQueue = this.#eventQueue
      .then(async () => {
        const current = this.#pendingResult
        this.#pendingResult = null
        if (
          current === null ||
          generation !== this.#generation ||
          this.#state !== 'active'
        )
          return
        const body = new FormData()
        body.set(
          'screenshot',
          new Blob([Uint8Array.from(current.image)], { type: 'image/png' }),
          'result.png',
        )
        await this.api.request({
          method: 'POST',
          path: '/api/streamer/bot/battle-result',
          body,
          schema: SuccessSchema,
          timeoutMs: 150_000,
          signal: this.#eventController.signal,
        })
      })
      .catch(() => undefined)
  }
}
