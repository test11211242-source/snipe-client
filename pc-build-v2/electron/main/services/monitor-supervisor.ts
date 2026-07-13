import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  MonitorPreferencesSchema,
  MonitorResultSchema,
  MonitorViewSchema,
  type MonitorPreferences,
  type MonitorResult,
  type MonitorSessionStats,
  type MonitorState,
  type MonitorView,
} from '../../../shared/models/monitor'
import { MonitorStartPayloadSchema } from '../../../shared/contracts/monitor-protocol'
import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import {
  DEFAULT_MONITOR_PREFERENCES,
  type MonitorPreferencesRepository,
} from '../infrastructure/monitor-preferences-repository'
import type { AuthSession } from './auth-session'
import type { CaptureTargetResolver } from './capture-target-resolver'
import type { MonitorAction, MonitorProcessService } from './monitor-process-service'
import type { OcrApiClient } from './ocr-api-client'
import {
  PredictionRuntimeProfileSchema,
  type PredictionRuntimeProfile,
} from '../../../shared/models/prediction-result'

const EMPTY_STATS: MonitorSessionStats = Object.freeze({
  triggers: 0,
  requests: 0,
  droppedActions: 0,
  playersFound: 0,
  playersNotFound: 0,
  recognitionFailures: 0,
  serviceErrors: 0,
})

const TRANSITIONS: Readonly<Record<MonitorState, readonly MonitorState[]>> = {
  STOPPED: ['PREFLIGHT'],
  PREFLIGHT: ['STARTING', 'STOPPING', 'FAILED'],
  STARTING: ['READY', 'STOPPING', 'FAILED'],
  READY: ['STOPPING', 'FAILED'],
  STOPPING: ['STOPPED', 'FAILED'],
  FAILED: ['PREFLIGHT', 'STOPPING', 'STOPPED'],
}

function publicError(error: unknown): { code: string; message: string } {
  return error instanceof ApplicationError
    ? { code: error.code, message: error.message }
    : { code: 'MONITOR_FAILED', message: 'Monitoring could not be started' }
}

export class MonitorSupervisor {
  #view: MonitorView = MonitorViewSchema.parse({
    state: 'STOPPED',
    preferences: DEFAULT_MONITOR_PREFERENCES,
    readiness: { authenticated: false, captureConfigured: false, sourceAvailable: null },
    error: null,
    startedAt: null,
    stats: EMPTY_STATS,
    results: [],
  })
  #generation = 0
  #runController = new AbortController()
  #ocrController: AbortController | null = null
  #ocrActive = false
  #pendingAction: MonitorAction | null = null
  #startPromise: Promise<MonitorView> | null = null
  #stopPromise: Promise<MonitorView> | null = null
  readonly #resultListeners = new Set<(result: MonitorResult) => void | Promise<void>>()
  readonly #battleStartListeners = new Set<(timestamp: string) => void | Promise<void>>()
  readonly #predictionResultListeners = new Set<
    (action: MonitorAction) => void | Promise<void>
  >()
  #predictionProfile: PredictionRuntimeProfile | null = null

  constructor(
    private readonly auth: AuthSession,
    private readonly captureConfigurations: CaptureConfigurationRepository,
    private readonly preferences: MonitorPreferencesRepository,
    private readonly targetResolver: CaptureTargetResolver,
    private readonly process: MonitorProcessService,
    private readonly ocr: OcrApiClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getView(): Promise<MonitorView> {
    const user = this.auth.getView().user
    let configured = false
    if (user !== null) {
      const [configuration, preferences] = await Promise.all([
        this.captureConfigurations.load(user.id),
        this.preferences.load(user.id),
      ])
      configured = configuration !== null
      if (this.#view.state === 'STOPPED' || this.#view.state === 'FAILED') {
        this.patch({ preferences })
      }
    }
    this.patch({
      readiness: {
        ...this.#view.readiness,
        authenticated: user !== null,
        captureConfigured: configured,
        sourceAvailable: configured ? this.#view.readiness.sourceAvailable : null,
      },
    })
    return this.#view
  }

  getRetainedResult(resultId: string): MonitorResult | null {
    return this.#view.results.find((result) => result.id === resultId) ?? null
  }

  getLatestResult(): MonitorResult | null {
    return this.#view.results[0] ?? null
  }

  subscribeResults(
    listener: (result: MonitorResult) => void | Promise<void>,
  ): () => void {
    this.#resultListeners.add(listener)
    return () => this.#resultListeners.delete(listener)
  }

  addExternalResult(result: unknown): void {
    this.addResult(MonitorResultSchema.parse(result))
  }

  subscribeBattleStarts(
    listener: (timestamp: string) => void | Promise<void>,
  ): () => void {
    this.#battleStartListeners.add(listener)
    return () => this.#battleStartListeners.delete(listener)
  }

  subscribePredictionResults(
    listener: (action: MonitorAction) => void | Promise<void>,
  ): () => void {
    this.#predictionResultListeners.add(listener)
    return () => this.#predictionResultListeners.delete(listener)
  }

  async configurePredictionRuntime(
    profile: PredictionRuntimeProfile | null,
  ): Promise<MonitorView> {
    this.#predictionProfile =
      profile === null ? null : PredictionRuntimeProfileSchema.parse(profile)
    return this.#view.state === 'READY' ? this.restart() : this.#view
  }

  isRunning(): boolean {
    return this.#view.state === 'READY'
  }

  start(): Promise<MonitorView> {
    if (this.#startPromise !== null) {
      if (this.#view.state === 'PREFLIGHT' || this.#view.state === 'STARTING') {
        return this.#startPromise
      }
      return this.#startPromise.then(() => this.start())
    }
    if (this.#view.state === 'READY') return Promise.resolve(this.#view)
    if (this.#view.state === 'STOPPING' && this.#stopPromise !== null) {
      return this.#stopPromise.then(() => this.start())
    }
    const generation = ++this.#generation
    this.#runController.abort()
    this.#runController = new AbortController()
    this.#pendingAction = null
    this.#ocrActive = false
    this.transition('PREFLIGHT', {
      error: null,
      startedAt: null,
      stats: { ...EMPTY_STATS },
      results: [],
      readiness: {
        authenticated: this.auth.getView().user !== null,
        captureConfigured: false,
        sourceAvailable: null,
      },
    })
    const operation = this.runStart(generation).finally(() => {
      if (this.#startPromise === operation) this.#startPromise = null
    })
    this.#startPromise = operation
    return operation
  }

  stop(): Promise<MonitorView> {
    if (this.#stopPromise !== null) return this.#stopPromise
    if (this.#view.state === 'STOPPED') return Promise.resolve(this.#view)
    const generation = ++this.#generation
    this.#runController.abort()
    this.#ocrController?.abort()
    this.#ocrController = null
    this.#pendingAction = null
    this.transition('STOPPING')
    const operation = this.process
      .stop()
      .then(() => {
        if (generation === this.#generation && this.#view.state === 'STOPPING') {
          this.#ocrActive = false
          this.transition('STOPPED', { error: null, startedAt: null })
        }
        return this.#view
      })
      .catch((error: unknown) => {
        if (generation === this.#generation && this.#view.state === 'STOPPING') {
          this.transition('FAILED', { error: publicError(error), startedAt: null })
        }
        return this.#view
      })
      .finally(() => {
        if (this.#stopPromise === operation) this.#stopPromise = null
      })
    this.#stopPromise = operation
    return operation
  }

  async restart(): Promise<MonitorView> {
    await this.stop()
    return this.start()
  }

  async getPreferences(): Promise<MonitorPreferences> {
    const user = this.auth.getView().user
    if (user === null) return { ...DEFAULT_MONITOR_PREFERENCES }
    const value = await this.preferences.load(user.id)
    this.patch({ preferences: value })
    return value
  }

  async updatePreferences(value: MonitorPreferences): Promise<MonitorPreferences> {
    if (!['STOPPED', 'FAILED'].includes(this.#view.state)) {
      throw new ApplicationError(
        'MONITOR_ACTIVE',
        'Stop monitoring before changing search preferences',
      )
    }
    const user = this.auth.getView().user
    if (user === null)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to save preferences')
    const saved = await this.preferences.save(
      user.id,
      MonitorPreferencesSchema.parse(value),
    )
    this.patch({ preferences: saved })
    return saved
  }

  private async runStart(generation: number): Promise<MonitorView> {
    try {
      await this.process.stop()
      this.assertCurrent(generation)
      const user = this.auth.getView().user
      if (user === null)
        throw new ApplicationError('AUTH_REQUIRED', 'Sign in to start monitoring')
      const [token, preferences, resolved] = await Promise.all([
        this.auth.getAccessToken(),
        this.preferences.load(user.id),
        this.targetResolver.resolve(),
      ])
      this.assertCurrent(generation)
      if (token === null)
        throw new ApplicationError('AUTH_REQUIRED', 'Sign in again to start monitoring')
      this.patch({
        preferences,
        readiness: {
          authenticated: true,
          captureConfigured: true,
          sourceAvailable: true,
        },
      })
      this.transition('STARTING')
      const payload = MonitorStartPayloadSchema.parse({
        selector: resolved.selector,
        configuredFrameSize: resolved.configuration.frameSize,
        regions: resolved.configuration.regions,
        triggerProfile: resolved.configuration.triggerProfile,
        searchMode: preferences.searchMode,
        limits: {
          fps: 10,
          maxImageBytes: 10 * 1024 * 1024,
          maxImagePixels: 20_000_000,
          maxImageWidth: 8192,
          maxImageHeight: 8192,
          confirmationsNeeded: 2,
          confirmationDecay: 0.5,
          cooldownSeconds: 15,
        },
        prediction: this.#predictionProfile,
      })
      await this.process.start(payload, {
        onAction: (action) => this.acceptAction(generation, action),
        onPredictionResult: (action) => this.acceptPredictionResult(generation, action),
        onFatal: (error) => this.failRun(generation, error),
        onExit: (error) => {
          if (error !== null) this.failRun(generation, error)
        },
      })
      this.assertCurrent(generation)
      this.transition('READY', { startedAt: this.now().toISOString() })
    } catch (error) {
      if (generation !== this.#generation) {
        return this.#stopPromise === null ? this.#view : await this.#stopPromise
      }
      if (this.#view.state === 'STOPPING' || this.#view.state === 'STOPPED')
        return this.#view
      const failure = publicError(error)
      this.patch({
        readiness: {
          ...this.#view.readiness,
          sourceAvailable: ['SOURCE_NOT_FOUND', 'SOURCE_AMBIGUOUS'].includes(failure.code)
            ? false
            : this.#view.readiness.sourceAvailable,
        },
      })
      this.transition('FAILED', { error: failure, startedAt: null })
    }
    return this.#view
  }

  private acceptAction(generation: number, action: MonitorAction): void {
    if (generation !== this.#generation || this.#view.state !== 'READY') return
    for (const listener of this.#battleStartListeners) {
      try {
        void Promise.resolve(listener(action.timestamp)).catch(() => undefined)
      } catch {
        // Private one-way notifications cannot affect normal monitor processing.
      }
    }
    this.increment('triggers')
    if (this.#ocrActive) {
      if (this.#pendingAction !== null) this.increment('droppedActions')
      this.#pendingAction = action
      return
    }
    void this.processAction(generation, action)
  }

  private acceptPredictionResult(generation: number, action: MonitorAction): void {
    if (
      generation !== this.#generation ||
      this.#view.state !== 'READY' ||
      this.#predictionProfile === null
    )
      return
    for (const listener of this.#predictionResultListeners) {
      try {
        const copy = { ...action, image: Buffer.from(action.image) }
        void Promise.resolve(listener(copy)).catch(() => undefined)
      } catch {
        // Private images remain inside main and listener failures are isolated.
      }
    }
  }

  private async processAction(generation: number, action: MonitorAction): Promise<void> {
    if (generation !== this.#generation) return
    this.#ocrActive = true
    const controller = new AbortController()
    this.#ocrController = controller
    this.increment('requests')
    try {
      let result: MonitorResult
      try {
        result = await this.ocr.process({
          image: action.image,
          timestamp: action.timestamp,
          searchMode: this.#view.preferences.searchMode,
          deckMode: this.#view.preferences.deckMode,
          signal: controller.signal,
        })
      } catch {
        result = MonitorResultSchema.parse({
          id: randomUUID(),
          kind: 'service_error',
          timestamp: action.timestamp,
          searchMode: this.#view.preferences.searchMode,
          deckMode: this.#view.preferences.deckMode,
          searchedNickname: null,
          message: 'Внутренняя ошибка клиента OCR',
          retryable: true,
          authBlocked: false,
        })
      }
      if (generation !== this.#generation) return
      this.addResult(result)
    } finally {
      if (generation === this.#generation) {
        if (this.#ocrController === controller) this.#ocrController = null
        this.#ocrActive = false
        const pending = this.#pendingAction
        this.#pendingAction = null
        if (pending !== null) void this.processAction(generation, pending)
      }
    }
  }

  private addResult(result: MonitorResult): void {
    const key =
      result.kind === 'player_found'
        ? 'playersFound'
        : result.kind === 'player_not_found'
          ? 'playersNotFound'
          : result.kind === 'recognition_failed'
            ? 'recognitionFailures'
            : 'serviceErrors'
    this.increment(key)
    this.patch({ results: [result, ...this.#view.results].slice(0, 20) })
    for (const listener of this.#resultListeners) {
      try {
        void Promise.resolve(listener(MonitorResultSchema.parse(result))).catch(
          () => undefined,
        )
      } catch {
        // Result notifications are one-way and cannot affect monitor state.
      }
    }
  }

  private increment(key: keyof MonitorSessionStats): void {
    this.patch({ stats: { ...this.#view.stats, [key]: this.#view.stats[key] + 1 } })
  }

  private failRun(generation: number, error: ApplicationError): void {
    if (
      generation !== this.#generation ||
      this.#view.state === 'STOPPING' ||
      this.#view.state === 'STOPPED' ||
      this.#view.state === 'FAILED'
    ) {
      return
    }
    ++this.#generation
    this.#ocrController?.abort()
    this.#pendingAction = null
    this.#ocrActive = false
    this.transition('FAILED', { error: publicError(error), startedAt: null })
    void this.process.stop()
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.#generation || this.#runController.signal.aborted) {
      throw new ApplicationError('MONITOR_CANCELLED', 'Monitor start was cancelled')
    }
  }

  private transition(state: MonitorState, patch: Partial<MonitorView> = {}): void {
    if (!TRANSITIONS[this.#view.state].includes(state)) {
      throw new Error(`Invalid monitor transition: ${this.#view.state} -> ${state}`)
    }
    this.patch({ ...patch, state })
  }

  private patch(patch: Partial<MonitorView>): void {
    this.#view = MonitorViewSchema.parse({ ...this.#view, ...patch })
  }
}
