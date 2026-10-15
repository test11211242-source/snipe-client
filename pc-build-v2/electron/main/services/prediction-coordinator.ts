import { z } from 'zod'

import type {
  MonitorPredictionResultEvent,
  MonitorTriggeredEvent,
} from '../../../shared/contracts/monitor-protocol'
import { ApplicationError } from '../../../shared/errors/application-error'
import { hasStreamerRole } from '../../../shared/models/auth'
import type { CaptureConfiguration } from '../../../shared/models/capture'
import type { MonitorView } from '../../../shared/models/monitor'
import {
  PredictionSettingsSchema,
  PredictionStatusSchema,
  type PredictionSettings,
  type PredictionStatus,
} from '../../../shared/models/streamer'
import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { AuthSession } from './auth-session'
import type { AuthenticatedApiClient } from './api-client'
import type { MonitorSupervisor } from './monitor-supervisor'

const CodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64)
const BattleStartResponseSchema = z
  .object({
    accepted: z.boolean(),
    reason: CodeSchema,
  })
  .strict()
const BattleResultResponseSchema = z
  .object({
    applied: z.boolean(),
    finalOutcome: CodeSchema.nullable(),
    reason: CodeSchema,
  })
  .strict()
const ManualBattleRequestSchema = z
  .object({
    predictionId: z.number().int().positive(),
    outcome: z.enum(['win', 'loss']),
  })
  .strict()
const CurrentPredictionRequestSchema = z
  .object({ predictionId: z.number().int().positive() })
  .strict()

type BattleStart = MonitorTriggeredEvent['payload']
type BattleResult = MonitorPredictionResultEvent['payload']
interface Context {
  userId: string
  generation: number
  signal: AbortSignal
}
type Operation =
  | 'heartbeat'
  | 'battle_start'
  | 'battle_result'
  | 'settings_save'
  | 'manual_battle'
  | 'cancel'
/**
 * `network` repeats once after 2 s on a transport failure; only for requests the
 * server applies idempotently. `none` never repeats: a lost manual-settle response
 * may already have advanced a streak, so a resend could count the battle twice.
 */
type RetryPolicy = 'network' | 'battle_event' | 'none'

export interface PredictionReadiness {
  ready: boolean
  reason: 'ok' | 'monitor_not_ready' | 'profile_not_own_battle' | 'profile_full_frame'
}

/** C1 intentionally needs no result setup; C3 supplies result recognition later. */
export function getPredictionReadiness(
  configuration: CaptureConfiguration | null,
  monitor: Pick<MonitorView, 'state' | 'runIntent' | 'sourceMinimized'>,
): PredictionReadiness {
  if (monitor.state !== 'READY' || !monitor.runIntent || monitor.sourceMinimized)
    return { ready: false, reason: 'monitor_not_ready' }
  return getPredictionProfileReadiness(configuration)
}

export function getPredictionProfileReadiness(
  configuration: CaptureConfiguration | null,
): PredictionReadiness {
  if (configuration === null) return { ready: false, reason: 'profile_not_own_battle' }
  const calibration = configuration.calibration
  if (calibration.coordinateSpace !== 'game_relative')
    return { ready: false, reason: 'profile_full_frame' }
  // Same own-battle band as python/geometry/zones.py:layout_kind. A structural
  // trigger has no badge position and therefore cannot establish an own battle.
  if (
    calibration.layouts.length === 0 ||
    !calibration.layouts.every(
      (layout) =>
        layout.trigger.kind === 'vs_edge_orientation' &&
        layout.trigger.badge.cy >= 0.4 &&
        layout.trigger.badge.cy < 0.46,
    )
  )
    return { ready: false, reason: 'profile_not_own_battle' }
  return { ready: true, reason: 'ok' }
}

export class PredictionCoordinator {
  #context: Context | null = null
  #controller = new AbortController()
  #heartbeatController = new AbortController()
  #heartbeatTimer: NodeJS.Timeout | undefined
  #eventQueue: Promise<void> = Promise.resolve()
  #disposers: (() => void)[] = []
  #started = false
  #monitorSignature: string | null = null

  constructor(
    private readonly auth: AuthSession,
    private readonly api: AuthenticatedApiClient,
    private readonly monitor: MonitorSupervisor,
    private readonly captures: CaptureConfigurationRepository,
    private readonly logger: Pick<StructuredLogger, 'info'>,
    private readonly clientVersion: string,
  ) {}

  startLifecycle(): void {
    if (this.#started) return
    this.#started = true
    this.#disposers = [
      this.auth.subscribe(() => this.updateAuthContext()),
      this.monitor.subscribeBattleStarts((event) => this.enqueueBattleStart(event)),
      this.monitor.subscribePredictionResults((event) => this.enqueueResult(event)),
      this.monitor.subscribeViews((view) => {
        const signature = `${view.state}:${view.runIntent}:${view.sourceMinimized}`
        if (signature === this.#monitorSignature) return
        this.#monitorSignature = signature
        this.notifyContextChanged()
      }),
    ]
    this.updateAuthContext()
  }

  /** Profile commits call this as well as monitor and auth subscriptions. */
  notifyContextChanged(): void {
    if (!this.#started) return
    this.#heartbeatController.abort()
    this.#heartbeatController = new AbortController()
    const context = this.currentContext()
    if (context === null) return
    const signal = AbortSignal.any([context.signal, this.#heartbeatController.signal])
    void this.sendHeartbeat({ ...context, signal }).catch(() => undefined)
  }

  /** The server replaces the whole settings row, so a network retry is idempotent. */
  async saveSettings(settings: PredictionSettings): Promise<PredictionStatus> {
    return this.request(
      this.requireContext(),
      'settings_save',
      'PUT',
      '/api/streamer/predictions/settings',
      PredictionStatusSchema,
      PredictionSettingsSchema.parse(settings),
      'network',
    )
  }

  /** Never retried: a lost response may already have advanced the streak. */
  async manualBattle(
    predictionId: number,
    outcome: 'win' | 'loss',
  ): Promise<PredictionStatus> {
    return this.request(
      this.requireContext(),
      'manual_battle',
      'POST',
      '/api/streamer/predictions/current/battle',
      PredictionStatusSchema,
      ManualBattleRequestSchema.parse({ predictionId, outcome }),
      'none',
    )
  }

  /** Never retried: a lost response is reconciled by the next status read. */
  async cancel(predictionId: number): Promise<PredictionStatus> {
    return this.request(
      this.requireContext(),
      'cancel',
      'POST',
      '/api/streamer/predictions/current/cancel',
      PredictionStatusSchema,
      CurrentPredictionRequestSchema.parse({ predictionId }),
      'none',
    )
  }

  shutdown(): Promise<void> {
    this.#started = false
    for (const dispose of this.#disposers) dispose()
    this.#disposers = []
    this.clearContext()
    // Closing CR Tools never disables predictions or cancels viewers' bets.
    return Promise.resolve()
  }

  private clearContext(): void {
    this.#controller.abort()
    this.#controller = new AbortController()
    this.#heartbeatController.abort()
    clearInterval(this.#heartbeatTimer)
    this.#heartbeatTimer = undefined
    this.#eventQueue = Promise.resolve()
    this.#context = null
    this.#monitorSignature = null
  }

  private updateAuthContext(): void {
    const view = this.auth.getView()
    const generation = this.auth.getContextGeneration()
    const userId = hasStreamerRole(view) ? (view.user?.id ?? null) : null
    if (userId === this.#context?.userId && generation === this.#context.generation)
      return
    this.clearContext()
    if (userId === null || !this.#started) return
    this.#context = { userId, generation, signal: this.#controller.signal }
    this.#heartbeatTimer = setInterval(() => this.notifyContextChanged(), 30_000)
    this.notifyContextChanged()
  }

  private currentContext(): Context | null {
    return this.#context !== null && this.isCurrent(this.#context) ? this.#context : null
  }

  private requireContext(): Context {
    const context = this.currentContext()
    if (context === null)
      throw new ApplicationError('STREAMER_ROLE_REQUIRED', 'Streamer role is required')
    return context
  }

  private isCurrent(context: Context): boolean {
    return (
      !context.signal.aborted &&
      this.auth.getContextGeneration() === context.generation &&
      hasStreamerRole(this.auth.getView()) &&
      this.auth.getView().user?.id === context.userId
    )
  }

  private async sendHeartbeat(context: Context): Promise<void> {
    const [capture, monitor] = await Promise.allSettled([
      this.captures.getActive(context.userId),
      this.monitor.getView(),
    ])
    if (!this.isCurrent(context)) return
    const readiness =
      monitor.status === 'fulfilled'
        ? getPredictionReadiness(
            capture.status === 'fulfilled'
              ? (capture.value?.profile.configuration ?? null)
              : null,
            monitor.value,
          )
        : { ready: false, reason: 'monitor_not_ready' as const }
    await this.request(
      context,
      'heartbeat',
      'POST',
      '/api/streamer/predictions/heartbeat',
      PredictionStatusSchema,
      { clientVersion: this.clientVersion, ...readiness },
      'network',
    )
  }

  private enqueueBattleStart(event: BattleStart): void {
    if (event.kind !== 'battle') {
      this.log('battle_start', { code: 'skipped', reason: 'not_own_battle' })
      return
    }
    // The server deduplicates by battleId, including uncertain HTTP 5xx responses.
    this.enqueue('battle_start', (context) =>
      this.request(
        context,
        'battle_start',
        'POST',
        '/api/streamer/predictions/battle-start',
        BattleStartResponseSchema,
        {
          battleId: event.triggerId,
          kind: 'battle',
          rank: event.rank,
          rankEvidence: event.rankEvidence,
        },
        'battle_event',
      ),
    )
  }

  private enqueueResult(event: BattleResult): void {
    this.enqueue('battle_result', (context) =>
      this.request(
        context,
        'battle_result',
        'POST',
        '/api/streamer/predictions/battle-result',
        BattleResultResponseSchema,
        event,
        'battle_event',
      ),
    )
  }

  private enqueue(
    operation: Operation,
    run: (context: Context) => Promise<unknown>,
  ): void {
    const context = this.currentContext()
    if (context === null) {
      this.log(operation, { code: 'skipped', reason: 'auth_context_changed' })
      return
    }
    this.#eventQueue = this.#eventQueue
      .then(async () => {
        if (!this.isCurrent(context)) {
          this.log(operation, { code: 'skipped', reason: 'auth_context_changed' })
          return
        }
        await run(context)
      })
      .catch(() => undefined)
  }

  private async request<T>(
    context: Context,
    operation: Operation,
    method: 'POST' | 'PUT',
    path: `/api/${string}`,
    schema: z.ZodType<T>,
    body: unknown,
    retry: RetryPolicy,
  ): Promise<T> {
    const attempts = retry === 'none' ? 1 : 2
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!this.isCurrent(context)) {
        this.log(operation, { code: 'AUTH_CANCELLED', attempt })
        throw new ApplicationError('AUTH_CANCELLED', 'Prediction request was cancelled')
      }
      let code: string
      let status: number | undefined
      try {
        const result = await this.api.request({
          method,
          path,
          schema,
          body,
          timeoutMs: 15_000,
          signal: context.signal,
          authContextGuard: () => this.isCurrent(context),
        })
        if (result.ok) {
          const data = result.data as Record<string, unknown>
          if (!this.isCurrent(context)) {
            code = 'AUTH_CANCELLED'
          } else {
            this.log(operation, {
              code: 'ok',
              attempt,
              status: result.status,
              ...(typeof data['accepted'] === 'boolean'
                ? { accepted: data['accepted'] }
                : {}),
              ...(typeof data['applied'] === 'boolean'
                ? { applied: data['applied'] }
                : {}),
              ...(CodeSchema.safeParse(data['reason']).success
                ? { reason: data['reason'] }
                : {}),
              ...(CodeSchema.safeParse(data['finalOutcome']).success
                ? { finalOutcome: data['finalOutcome'] }
                : {}),
            })
            return result.data
          }
        } else {
          code = result.error.code
          status = result.error.status ?? undefined
        }
      } catch (error) {
        code = error instanceof ApplicationError ? error.code : 'UNKNOWN'
      }
      this.log(operation, { code, attempt, ...(status === undefined ? {} : { status }) })
      if (
        attempt === attempts ||
        (code !== 'NETWORK_UNAVAILABLE' &&
          code !== 'REQUEST_TIMEOUT' &&
          !(
            retry === 'battle_event' &&
            status !== undefined &&
            status >= 500 &&
            status <= 599
          ))
      )
        throw new ApplicationError(code, 'Prediction request failed')
      await this.retryDelay(context.signal)
    }
    throw new ApplicationError('UNKNOWN', 'Prediction request failed')
  }

  private async retryDelay(signal: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const finish = (): void => resolve(undefined)
    const timer = setTimeout(finish, 2_000)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
    await promise
    clearTimeout(timer)
    signal.removeEventListener('abort', finish)
  }

  private log(operation: Operation, codes: Record<string, unknown>): void {
    this.logger.info(`prediction.${operation}`, codes)
  }
}
