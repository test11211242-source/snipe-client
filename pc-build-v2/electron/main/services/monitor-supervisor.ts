import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import { MONITOR_ERROR_MESSAGES } from '../../../shared/errors/monitor-error-messages'
import {
  MonitorPreferencesSchema,
  MonitorResultSchema,
  MonitorViewSchema,
  type MonitorPreferences,
  type MonitorResult,
  type MonitorSessionStats,
  type MonitorState,
  type MonitorView,
  type MonitorSession,
  type DeckMode,
} from '../../../shared/models/monitor'
import {
  MonitorStartPayloadSchema,
  type GameLayoutWire,
  type MonitorGeometryEvent,
  type MonitorLearningEvent,
  type MonitorLayoutLearnedEvent,
  type MonitorPredictionStateEvent,
} from '../../../shared/contracts/monitor-protocol'
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
import {
  canonicalOpponentTag,
  HISTORY_LIMIT,
  localCalendarDay,
  pruneJournal,
  type MonitorJournal,
  type MonitorJournalRepository,
} from '../infrastructure/monitor-journal-repository'

type LearnedLayoutHandler = (
  userId: string,
  profileId: string,
  calibrationId: string,
  layout: GameLayoutWire,
) => Promise<number>

interface SearchAction extends MonitorAction {
  triggerId: string
  deckMode: DeckMode
}

const RECOVERABLE_SOURCE_CODES: Readonly<Record<string, true>> = {
  SOURCE_NOT_FOUND: true,
  SOURCE_AMBIGUOUS: true,
  SOURCE_METADATA_UNAVAILABLE: true,
  CAPTURE_SOURCE_CLOSED: true,
  CAPTURE_NO_FRAME: true,
}
const SOURCE_RECOVERY_DELAYS = [1_000, 2_000, 5_000, 10_000] as const

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
  PREFLIGHT: ['STARTING', 'STOPPING', 'FAILED', 'WAITING_SOURCE'],
  STARTING: ['READY', 'STOPPING', 'FAILED', 'WAITING_SOURCE'],
  READY: ['STOPPING', 'FAILED', 'WAITING_SOURCE'],
  WAITING_SOURCE: ['PREFLIGHT', 'STOPPING', 'FAILED'],
  STOPPING: ['STOPPED', 'FAILED'],
  FAILED: ['PREFLIGHT', 'STOPPING', 'STOPPED'],
}

function publicError(error: unknown): { code: string; message: string } {
  return error instanceof ApplicationError
    ? {
        code: error.code,
        message:
          MONITOR_ERROR_MESSAGES[error.code] ??
          'Ошибка локального мониторинга. Повторите попытку.',
      }
    : {
        code: 'MONITOR_FAILED',
        message:
          MONITOR_ERROR_MESSAGES['MONITOR_FAILED'] ??
          'Не удалось запустить локальный мониторинг.',
      }
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
  #viewSeq = 0
  #runController = new AbortController()
  #ocrController: AbortController | null = null
  #ocrActive = false
  #pendingAction: SearchAction | null = null
  #startPromise: Promise<MonitorView> | null = null
  #cancelStart: ((value: MonitorView | PromiseLike<MonitorView>) => void) | null = null
  #stopPromise: Promise<MonitorView> | null = null
  #stopIntentGeneration = 0
  readonly #resultListeners = new Set<(result: MonitorResult) => void | Promise<void>>()
  readonly #battleStartListeners = new Set<(timestamp: string) => void | Promise<void>>()
  readonly #predictionResultListeners = new Set<
    (action: MonitorAction) => void | Promise<void>
  >()
  #predictionProfile: PredictionRuntimeProfile | null = null
  #userContextId: string | null = null
  #userContextGeneration = 0
  readonly #viewListeners = new Set<(view: MonitorView) => void>()
  #recoveryTimer: ReturnType<typeof setTimeout> | null = null
  #recoveryAttempt = 0
  #bindingFingerprint: string | null = null
  #profileId: string | null = null
  #calibrationRevision: number | null = null
  #learningFailure: MonitorLearningEvent['payload'] | null = null
  #lastTriggerId: string | null = null
  #retry: { action: SearchAction; attemptId: string; expiresAt: number } | null = null
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #retryPromise: Promise<MonitorView> | null = null
  #journal: MonitorJournal | null = null
  #journalWritable = false
  #journalWrite: Promise<void> | null = null
  #sessionTags = new Map<string, number>()
  #sessionRepeats = new Set<string>()
  #learnedLayoutHandler: LearnedLayoutHandler | null = null
  readonly #learnedLayoutListeners = new Set<(layoutId: string) => void | Promise<void>>()
  readonly #predictionStateListeners = new Set<
    (state: MonitorPredictionStateEvent['payload']['state']) => void | Promise<void>
  >()

  constructor(
    private readonly auth: AuthSession,
    private readonly captureConfigurations: CaptureConfigurationRepository,
    private readonly preferences: MonitorPreferencesRepository,
    private readonly targetResolver: CaptureTargetResolver,
    private readonly process: MonitorProcessService,
    private readonly ocr: OcrApiClient,
    private readonly now: () => Date = () => new Date(),
    private readonly journalRepository?: MonitorJournalRepository,
    private readonly logger?: { warn: (message: string, context?: unknown) => void },
  ) {
    this.#userContextId = this.auth.getView().user?.id ?? null
  }

  async getView(): Promise<MonitorView> {
    const user = this.auth.getView().user
    if (user?.id !== this.#userContextId) {
      if (this.#view.state === 'STOPPED' || this.#view.state === 'FAILED') {
        this.setUserContext(user?.id ?? null)
      } else {
        void this.stop('auth_change')
        return this.redactedView(user !== null)
      }
    }
    const contextGeneration = this.#userContextGeneration
    let configured = false
    if (user !== null) {
      await this.loadJournal(user.id, contextGeneration)
      const [configuration, preferences] = await Promise.all([
        this.captureConfigurations.load(user.id),
        this.preferences.load(user.id),
      ])
      if (!this.isUserContextCurrent(user.id, contextGeneration)) {
        return this.redactedView(this.auth.getView().user !== null)
      }
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
    return this.getCurrentView()
  }

  getCurrentView(): MonitorView {
    return this.auth.getView().user?.id === this.#userContextId
      ? MonitorViewSchema.parse({
          ...this.#view,
          seq: ++this.#viewSeq,
          session: this.sessionSnapshot(),
        })
      : this.redactedView(this.auth.getView().user !== null)
  }

  subscribeViews(listener: (view: MonitorView) => void): () => void {
    this.#viewListeners.add(listener)
    return () => this.#viewListeners.delete(listener)
  }

  setLearnedLayoutHandler(handler: LearnedLayoutHandler): void {
    this.#learnedLayoutHandler = handler
  }

  subscribeLearnedLayouts(
    listener: (layoutId: string) => void | Promise<void>,
  ): () => void {
    this.#learnedLayoutListeners.add(listener)
    return () => this.#learnedLayoutListeners.delete(listener)
  }

  subscribePredictionStates(
    listener: (
      state: MonitorPredictionStateEvent['payload']['state'],
    ) => void | Promise<void>,
  ): () => void {
    this.#predictionStateListeners.add(listener)
    return () => this.#predictionStateListeners.delete(listener)
  }

  async getHistory(offset = 0, limit = 50): Promise<MonitorResult[]> {
    const userId = this.auth.getView().user?.id ?? null
    const generation = this.#userContextGeneration
    if (userId === null || !this.isUserContextCurrent(userId, generation)) return []
    await this.loadJournal(userId, generation)
    if (!this.isUserContextCurrent(userId, generation)) return []
    return (this.#journal?.results ?? this.#view.results).slice(offset, offset + limit)
  }

  flushJournal(): Promise<void> {
    return this.#journalWrite ?? Promise.resolve()
  }

  retrySearch(attemptId: string): Promise<MonitorView> {
    if (this.#retryPromise !== null && this.#retry?.attemptId === attemptId)
      return this.#retryPromise
    const retained = this.#retry
    if (retained?.attemptId !== attemptId) {
      return Promise.reject(
        new ApplicationError('SEARCH_RETRY_STALE', 'The search was superseded'),
      )
    }
    if (this.now().getTime() >= retained.expiresAt) {
      this.clearRetry()
      return Promise.reject(
        new ApplicationError('SEARCH_RETRY_EXPIRED', 'The retained crop expired'),
      )
    }
    if (!this.#view.runIntent || this.#ocrActive || this.#view.state !== 'READY') {
      return Promise.reject(
        new ApplicationError('SEARCH_RETRY_UNAVAILABLE', 'Search cannot be retried now'),
      )
    }
    const userId = this.auth.getView().user?.id
    if (userId === undefined || userId !== this.#userContextId) {
      return Promise.reject(new ApplicationError('AUTH_REQUIRED', 'Sign in to retry'))
    }
    const operation = this.processAction(
      this.#generation,
      userId,
      this.#userContextGeneration,
      retained.action,
    )
      .then(() => this.getCurrentView())
      .finally(() => {
        if (this.#retryPromise === operation) this.#retryPromise = null
      })
    this.#retryPromise = operation
    return operation
  }

  getRetainedResult(resultId: string): MonitorResult | null {
    if (this.auth.getView().user?.id !== this.#userContextId) return null
    return (
      (this.#journal?.results ?? this.#view.results).find(
        (result) => result.id === resultId,
      ) ?? null
    )
  }

  getLatestResult(): MonitorResult | null {
    if (this.auth.getView().user?.id !== this.#userContextId) return null
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
    return ['PREFLIGHT', 'STARTING', 'READY'].includes(this.#view.state)
      ? this.restart()
      : this.#view
  }

  isRunning(): boolean {
    return this.#view.state === 'READY'
  }

  invalidateCaptureTarget(): MonitorView {
    this.patch({
      readiness: {
        ...this.#view.readiness,
        captureConfigured: true,
        sourceAvailable: null,
      },
      ...(['STOPPED', 'FAILED'].includes(this.#view.state) ? { error: null } : {}),
    })
    return this.#view
  }

  setUserContext(userId: string | null): boolean {
    if (this.#userContextId === userId) return false
    if (this.#view.state !== 'STOPPED' && this.#view.state !== 'FAILED') {
      throw new ApplicationError(
        'MONITOR_ACTIVE',
        'Stop monitoring before changing the user context',
      )
    }
    this.#userContextId = userId
    ++this.#userContextGeneration
    ++this.#generation
    this.#runController.abort()
    this.#ocrController?.abort()
    this.#ocrController = null
    this.#ocrActive = false
    this.#pendingAction = null
    this.#predictionProfile = null
    this.cancelRecovery()
    this.clearRetry()
    this.#journal = null
    this.#journalWritable = false
    this.#sessionTags.clear()
    this.#sessionRepeats.clear()
    this.#bindingFingerprint = null
    this.#profileId = null
    this.#calibrationRevision = null
    this.patch({
      state: 'STOPPED',
      preferences: { ...DEFAULT_MONITOR_PREFERENCES },
      readiness: {
        authenticated: userId !== null,
        captureConfigured: false,
        sourceAvailable: null,
      },
      error: null,
      startedAt: null,
      stats: { ...EMPTY_STATS },
      results: [],
      runIntent: false,
      search: null,
      session: null,
      summary: null,
      historyError: null,
      geometry: null,
    })
    return true
  }

  start(): Promise<MonitorView> {
    if (this.#view.state === 'STOPPED' || this.#view.state === 'FAILED') {
      this.setUserContext(this.auth.getView().user?.id ?? null)
    }
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
    this.cancelRecovery()
    const userId = this.auth.getView().user?.id ?? null
    const contextGeneration = this.#userContextGeneration
    const generation = ++this.#generation
    this.#runController.abort()
    this.#runController = new AbortController()
    this.#learningFailure = null
    this.#pendingAction = null
    this.#ocrActive = false
    const session = this.#view.session
    const continuing = session?.endedAt === null
    if (!continuing) {
      this.#sessionTags.clear()
      this.#sessionRepeats.clear()
      this.#bindingFingerprint = null
    }
    const startedAt = continuing ? session.startedAt : this.now().toISOString()
    this.transition('PREFLIGHT', {
      error: null,
      geometry: null,
      runIntent: true,
      startedAt,
      ...(continuing
        ? {}
        : {
            stats: { ...EMPTY_STATS },
            results: [],
            summary: null,
            session:
              userId === null
                ? null
                : {
                    sessionId: randomUUID(),
                    userId,
                    startedAt,
                    endedAt: null,
                    initialProfileId: null,
                    stopReason: null,
                    durationMs: 0,
                    stats: { ...EMPTY_STATS },
                    repeatEncounters: 0,
                    distinctRepeatedOpponents: 0,
                  },
          }),
      search: null,
    })
    let cancelStart!: (value: MonitorView | PromiseLike<MonitorView>) => void
    const cancelled = new Promise<MonitorView>((resolve) => {
      cancelStart = resolve
    })
    const operation = Promise.race([
      this.runStart(generation, userId, contextGeneration),
      cancelled,
    ]).finally(() => {
      if (this.#startPromise === operation) {
        this.#startPromise = null
        this.#cancelStart = null
      }
    })
    this.#cancelStart = cancelStart
    this.#startPromise = operation
    return operation
  }

  stop(reason: MonitorSession['stopReason'] = 'user'): Promise<MonitorView> {
    ++this.#stopIntentGeneration
    this.cancelRecovery()
    this.clearRetry()
    this.patch({ runIntent: false, search: null, geometry: null })
    if (reason !== null) this.finalizeSession(reason)
    if (this.#stopPromise !== null) return this.#stopPromise
    if (this.#view.state === 'STOPPED') {
      return this.#journalWrite === null
        ? Promise.resolve(this.#view)
        : this.#journalWrite.then(() => this.#view)
    }
    const cancelStart = this.#cancelStart
    if (this.#view.state === 'PREFLIGHT' || this.#view.state === 'STARTING') {
      this.#startPromise = null
      this.#cancelStart = null
    }
    const generation = ++this.#generation
    this.#runController.abort()
    this.#ocrController?.abort()
    this.#ocrController = null
    this.#pendingAction = null
    this.transition('STOPPING')
    const operation = this.process
      .stop()
      .then(async () => {
        await this.#journalWrite
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
    cancelStart?.(operation)
    return operation
  }

  async restart(): Promise<MonitorView> {
    const expectedStopIntent = this.#stopIntentGeneration + 1
    await this.stop(null)
    if (this.#stopIntentGeneration !== expectedStopIntent) return this.#view
    this.#bindingFingerprint = null
    return this.start()
  }

  restartIfActive(): Promise<MonitorView> {
    return this.#view.runIntent ? this.restart() : Promise.resolve(this.#view)
  }

  async getPreferences(): Promise<MonitorPreferences> {
    const user = this.auth.getView().user
    if (user === null) return { ...DEFAULT_MONITOR_PREFERENCES }
    const contextGeneration = this.#userContextGeneration
    const value = await this.preferences.load(user.id)
    this.assertUserContext(user.id, contextGeneration)
    this.patch({ preferences: value })
    return value
  }

  async updatePreferences(value: MonitorPreferences): Promise<MonitorPreferences> {
    const user = this.auth.getView().user
    if (user === null)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to save preferences')
    const contextGeneration = this.#userContextGeneration
    const saved = await this.preferences.save(
      user.id,
      MonitorPreferencesSchema.parse(value),
    )
    this.assertUserContext(user.id, contextGeneration)
    this.patch({ preferences: saved })
    return saved
  }

  private async runStart(
    generation: number,
    userId: string | null,
    contextGeneration: number,
  ): Promise<MonitorView> {
    try {
      await this.process.stop()
      this.assertCurrent(generation, userId, contextGeneration)
      if (userId === null)
        throw new ApplicationError('AUTH_REQUIRED', 'Sign in to start monitoring')
      await this.loadJournal(userId, contextGeneration)
      this.assertCurrent(generation, userId, contextGeneration)
      const active = await this.captureConfigurations.getActive(userId)
      this.assertCurrent(generation, userId, contextGeneration)
      if (active === null)
        throw new ApplicationError(
          'CAPTURE_NOT_CONFIGURED',
          'Configure a capture profile',
        )
      const activeCalibration = active.profile.configuration.calibration
      // Same-calibration game-relative recovery intentionally reloads the latest
      // source and zones; only a new profile/calibration invalidates its binding.
      const bindingFingerprint =
        activeCalibration.coordinateSpace === 'game_relative'
          ? `game:${active.profile.profileId}:${activeCalibration.calibrationId}`
          : active.profile.configuration.fingerprint
      if (
        this.#bindingFingerprint !== null &&
        this.#bindingFingerprint !== bindingFingerprint
      ) {
        throw new ApplicationError(
          'CAPTURE_CALIBRATION_INVALID',
          'The capture profile changed during recovery',
        )
      }
      this.#bindingFingerprint = bindingFingerprint
      this.#profileId = active.profile.profileId
      this.#calibrationRevision = active.profile.configuration.calibration.revision
      if (this.#view.session !== null && this.#view.session.initialProfileId === null) {
        this.patch({
          session: { ...this.#view.session, initialProfileId: active.profile.profileId },
        })
      }
      const [token, preferences, resolved] = await Promise.all([
        this.auth.getAccessToken(),
        this.preferences.load(userId),
        this.targetResolver.resolve(),
      ])
      this.assertCurrent(generation, userId, contextGeneration)
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
      const calibration = resolved.configuration.calibration
      const profileId = active.profile.profileId
      const calibrationId = calibration.calibrationId
      const primary =
        calibration.coordinateSpace === 'game_relative'
          ? {
              kind: 'game_relative' as const,
              profileCalibrationId: calibrationId,
              layouts: calibration.layouts.map((layout) => ({
                layoutId: layout.layoutId,
                layoutSource: layout.layoutSource,
                calibratedAt: layout.calibratedAt,
                gameAspect: layout.gameAspect,
                windowChrome: layout.windowChrome,
                regions: {
                  trigger: layout.triggerRegion,
                  nicknameRegion: layout.nicknameRegion,
                  topLeftEvidenceRegion: layout.topLeftEvidenceRegion,
                },
                trigger: layout.trigger,
                badge:
                  layout.trigger.kind === 'vs_edge_orientation'
                    ? layout.trigger.badge
                    : null,
                zonesOrigin: {
                  nickname:
                    layout.provenance.nickname.origin === 'auto' ? 'auto' : 'manual',
                  topLeftEvidence:
                    layout.provenance.topLeftEvidence.origin === 'auto'
                      ? 'auto'
                      : 'manual',
                },
              })),
              learning: {
                enabled: true,
                maxLayouts: 4,
              },
            }
          : {
              kind: 'full_frame' as const,
              configuredFrameSize: calibration.referenceFrameSize,
              regions: {
                trigger: calibration.triggerRegion,
                nicknameRegion: calibration.nicknameRegion,
                topLeftEvidenceRegion: calibration.topLeftEvidenceRegion,
              },
              triggerProfile: calibration.triggerProfile,
            }
      this.patch({
        geometry:
          primary.kind === 'game_relative'
            ? { state: 'locating', aspectLabel: null, learningFailure: null }
            : null,
      })
      const payload = MonitorStartPayloadSchema.parse({
        selector: resolved.selector,
        primary,
        capturePolicy: 'immediate_nickname',
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
      this.assertCurrent(generation, userId, contextGeneration)
      await this.process.start(payload, {
        onTriggered: (timestamp, triggerId) =>
          this.acceptTriggered(
            generation,
            userId,
            contextGeneration,
            timestamp,
            triggerId,
          ),
        onAction: (action) =>
          this.acceptAction(generation, userId, contextGeneration, action),
        onPredictionResult: (action) =>
          this.acceptPredictionResult(generation, userId, contextGeneration, action),
        onGeometry: (geometry) => {
          if (
            primary.kind === 'game_relative' &&
            this.isRuntimeCurrent(generation, userId, contextGeneration)
          )
            this.acceptGeometry(geometry)
        },
        onLearning: (learning) => {
          if (
            primary.kind === 'game_relative' &&
            this.isRuntimeCurrent(generation, userId, contextGeneration)
          )
            this.acceptLearning(learning)
        },
        onLayoutLearned: (learned) => {
          if (
            primary.kind === 'game_relative' &&
            this.isRuntimeCurrent(generation, userId, contextGeneration)
          )
            void this.acceptLearnedLayout(
              generation,
              userId,
              contextGeneration,
              profileId,
              calibrationId,
              learned,
            )
        },
        onPredictionState: ({ state }) => {
          if (!this.isRuntimeCurrent(generation, userId, contextGeneration)) return
          for (const listener of this.#predictionStateListeners) {
            try {
              void Promise.resolve(listener(state)).catch(() => undefined)
            } catch {
              // One-way prediction notifications cannot stop opponent monitoring.
            }
          }
        },
        onFatal: (error) => this.failRun(generation, userId, contextGeneration, error),
        onExit: (error) => {
          if (error !== null) this.failRun(generation, userId, contextGeneration, error)
        },
      })
      this.assertCurrent(generation, userId, contextGeneration)
      this.#recoveryAttempt = 0
      this.transition('READY')
    } catch (error) {
      if (!this.isCurrent(generation, userId, contextGeneration)) {
        if (
          generation === this.#generation &&
          !['STOPPED', 'STOPPING', 'FAILED'].includes(this.#view.state)
        ) {
          return await this.stop()
        }
        return this.#stopPromise === null ? this.#view : await this.#stopPromise
      }
      if (this.#view.state === 'STOPPING' || this.#view.state === 'STOPPED')
        return this.#view
      const failure = publicError(error)
      if (RECOVERABLE_SOURCE_CODES[failure.code] && this.#view.runIntent) {
        this.waitForSource(failure)
        return this.getCurrentView()
      }
      this.patch({
        readiness: {
          ...this.#view.readiness,
          sourceAvailable: ['SOURCE_NOT_FOUND', 'SOURCE_AMBIGUOUS'].includes(failure.code)
            ? false
            : this.#view.readiness.sourceAvailable,
        },
      })
      this.transition('FAILED', { error: failure, runIntent: false })
      this.finalizeSession('failed')
    }
    return this.#view
  }

  private acceptGeometry(geometry: MonitorGeometryEvent['payload']): void {
    const state = geometry.state === 'aspect_unknown' ? 'learning' : geometry.state
    if (state === 'armed') this.#learningFailure = null
    this.patch({
      geometry: {
        state: this.#learningFailure !== null ? 'learning_failed' : state,
        aspectLabel:
          geometry.gameAspect === null
            ? null
            : `9:${Number((9 / geometry.gameAspect).toFixed(1))}`,
        learningFailure: this.#learningFailure?.reason ?? null,
      },
    })
  }

  private acceptLearning(learning: MonitorLearningEvent['payload']): void {
    // Python emits waiting_vs only when it actually starts a fresh episode.
    if (learning.status === 'waiting_vs') this.#learningFailure = null
    else if (learning.status === 'failed') this.#learningFailure = learning
    this.patch({
      geometry: {
        state: this.#learningFailure !== null ? 'learning_failed' : 'learning',
        aspectLabel: this.#view.geometry?.aspectLabel ?? null,
        learningFailure: this.#learningFailure?.reason ?? null,
      },
    })
  }

  private async acceptLearnedLayout(
    generation: number,
    userId: string,
    contextGeneration: number,
    profileId: string,
    calibrationId: string,
    learned: MonitorLayoutLearnedEvent['payload'],
  ): Promise<void> {
    if (learned.calibrationId !== calibrationId) {
      this.logger?.warn('Learned layout not saved', {
        code: 'LAYOUT_STALE',
        profileId,
        calibrationId,
        layoutId: learned.layout.layoutId,
      })
      return
    }
    let revision: number
    try {
      if (this.#learnedLayoutHandler === null)
        throw new ApplicationError('LAYOUT_SAVE_FAILED', 'Layout storage unavailable')
      revision = await this.#learnedLayoutHandler(
        userId,
        profileId,
        calibrationId,
        learned.layout,
      )
    } catch (error) {
      const code = error instanceof ApplicationError ? error.code : 'LAYOUT_SAVE_FAILED'
      this.logger?.warn('Learned layout not saved', {
        code,
        profileId,
        calibrationId,
        layoutId: learned.layout.layoutId,
      })
      if (
        code !== 'LAYOUT_STALE' &&
        code !== 'LAYOUT_LIMIT' &&
        this.isRuntimeCurrent(generation, userId, contextGeneration)
      )
        this.patch({
          error: publicError(
            new ApplicationError('LAYOUT_SAVE_FAILED', 'Layout storage failed'),
          ),
        })
      return
    }
    if (!this.isRuntimeCurrent(generation, userId, contextGeneration)) return
    this.#calibrationRevision = revision
    if (this.#view.error?.code === 'LAYOUT_SAVE_FAILED') this.patch({ error: null })
    for (const listener of this.#learnedLayoutListeners) {
      try {
        void Promise.resolve(listener(learned.layout.layoutId)).catch(() => undefined)
      } catch {
        // Saving succeeded; notification failures cannot affect the active layout.
      }
    }
  }

  private acceptAction(
    generation: number,
    userId: string,
    contextGeneration: number,
    action: MonitorAction,
  ): void {
    if (
      !this.isCurrent(generation, userId, contextGeneration) ||
      !['STARTING', 'READY'].includes(this.#view.state)
    )
      return
    this.clearRetry()
    const captured: SearchAction = {
      ...action,
      triggerId: action.triggerId ?? this.#lastTriggerId ?? randomUUID(),
      deckMode: this.#view.preferences.deckMode,
    }
    if (this.#ocrActive) {
      if (this.#pendingAction !== null) this.increment('droppedActions')
      this.#pendingAction = captured
      return
    }
    void this.processAction(generation, userId, contextGeneration, captured)
  }

  private acceptTriggered(
    generation: number,
    userId: string,
    contextGeneration: number,
    timestamp: string,
    triggerId: string = randomUUID(),
  ): void {
    if (
      !this.isCurrent(generation, userId, contextGeneration) ||
      !['STARTING', 'READY'].includes(this.#view.state)
    )
      return
    this.#lastTriggerId = triggerId
    this.clearRetry()
    if (this.#profileId !== null && this.#calibrationRevision !== null) {
      this.patch({
        search: {
          triggerId,
          attemptId: randomUUID(),
          profileId: this.#profileId,
          calibrationRevision: this.#calibrationRevision,
          phase: 'capturing',
          startedAt: timestamp,
          searchedNickname: null,
          retryExpiresAt: null,
        },
      })
    }
    for (const listener of this.#battleStartListeners) {
      try {
        void Promise.resolve(listener(timestamp)).catch(() => undefined)
      } catch {
        // Private one-way notifications cannot affect normal monitor processing.
      }
    }
    this.increment('triggers')
  }

  private acceptPredictionResult(
    generation: number,
    userId: string,
    contextGeneration: number,
    action: MonitorAction,
  ): void {
    if (
      !this.isCurrent(generation, userId, contextGeneration) ||
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

  private async processAction(
    generation: number,
    userId: string,
    contextGeneration: number,
    action: SearchAction,
  ): Promise<void> {
    if (!this.isCurrent(generation, userId, contextGeneration)) return
    this.#ocrActive = true
    const attemptId =
      this.#view.search?.triggerId === action.triggerId &&
      this.#view.search.phase === 'capturing'
        ? this.#view.search.attemptId
        : randomUUID()
    const deckMode = action.deckMode
    const correlation = {
      sessionId: this.#view.session?.sessionId ?? null,
      triggerId: action.triggerId,
      attemptId,
      profileId: this.#profileId,
      calibrationRevision: this.#calibrationRevision,
      capturePolicy: 'immediate_nickname' as const,
    }
    if (this.#profileId !== null && this.#calibrationRevision !== null) {
      this.patch({
        search: {
          triggerId: action.triggerId,
          attemptId,
          profileId: this.#profileId,
          calibrationRevision: this.#calibrationRevision,
          phase: 'requesting',
          startedAt: this.now().toISOString(),
          searchedNickname: null,
          retryExpiresAt: null,
        },
      })
    }
    const controller = new AbortController()
    this.#ocrController = controller
    this.increment('requests')
    try {
      let result: MonitorResult
      try {
        result = await this.ocr.process({
          image: action.image,
          timestamp: action.timestamp,
          deckMode,
          signal: controller.signal,
        })
      } catch {
        result = MonitorResultSchema.parse({
          id: randomUUID(),
          kind: 'service_error',
          timestamp: action.timestamp,
          searchMode: 'fast',
          deckMode,
          searchedNickname: null,
          message: 'Внутренняя ошибка клиента OCR',
          retryable: true,
          authBlocked: false,
        })
      }
      if (!this.isCurrent(generation, userId, contextGeneration)) return
      result = MonitorResultSchema.parse({ ...result, ...correlation })
      const retryable =
        result.kind === 'service_error' && result.retryable && !result.authBlocked
      if (
        retryable &&
        action.image.byteLength <= 10 * 1024 * 1024 &&
        this.#view.search?.attemptId === attemptId &&
        this.#pendingAction === null
      ) {
        this.#retry = { action, attemptId, expiresAt: this.now().getTime() + 120_000 }
        if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
        this.#retryTimer = setTimeout(() => {
          this.clearRetry()
          if (this.#view.search?.attemptId === attemptId) {
            this.patch({ search: { ...this.#view.search, retryExpiresAt: null } })
          }
        }, 120_000)
        this.#retryTimer.unref()
      } else {
        this.clearRetry()
      }
      if (this.#view.search?.attemptId === attemptId) {
        this.patch({
          search: {
            ...this.#view.search,
            phase: result.kind === 'service_error' ? 'failed' : 'completed',
            searchedNickname: result.searchedNickname,
            retryExpiresAt:
              this.#retry === null ? null : new Date(this.#retry.expiresAt).toISOString(),
          },
        })
      }
      this.addResult(result)
    } finally {
      if (this.isCurrent(generation, userId, contextGeneration)) {
        if (this.#ocrController === controller) this.#ocrController = null
        this.#ocrActive = false
        const pending = this.#pendingAction
        this.#pendingAction = null
        if (pending !== null) {
          void this.processAction(generation, userId, contextGeneration, pending)
        }
      }
    }
  }

  private addResult(result: MonitorResult): void {
    if (this.auth.getView().user?.id !== this.#userContextId) return
    const history = this.#journal?.results ?? this.#view.results
    const previous = history.find(
      (entry) =>
        entry.id === result.id ||
        (!result.reprocessed &&
          !entry.reprocessed &&
          ((result.triggerId !== null && entry.triggerId === result.triggerId) ||
            (result.triggerId === null && entry.timestamp === result.timestamp))),
    )
    if (previous !== undefined) {
      result = MonitorResultSchema.parse({
        ...result,
        id: previous.id,
        sessionId: result.sessionId ?? previous.sessionId,
        triggerId: result.triggerId ?? previous.triggerId,
        attemptId: result.attemptId ?? previous.attemptId,
        profileId: result.profileId ?? previous.profileId,
        calibrationRevision: result.calibrationRevision ?? previous.calibrationRevision,
        capturePolicy: result.capturePolicy ?? previous.capturePolicy,
      })
    }
    const counter: Readonly<Record<MonitorResult['kind'], keyof MonitorSessionStats>> = {
      player_found: 'playersFound',
      player_not_found: 'playersNotFound',
      recognition_failed: 'recognitionFailures',
      service_error: 'serviceErrors',
    }
    const stats = { ...this.#view.stats }
    const currentSession =
      !result.reprocessed &&
      this.#view.session?.endedAt === null &&
      (result.sessionId === null || result.sessionId === this.#view.session.sessionId)
    if (currentSession) {
      if (previous === undefined) ++stats[counter[result.kind]]
      else if (previous.kind !== result.kind) {
        stats[counter[previous.kind]] = Math.max(0, stats[counter[previous.kind]] - 1)
        ++stats[counter[result.kind]]
      }
    }
    const tag = result.reprocessed ? null : canonicalOpponentTag(result)
    const previousTag =
      previous === undefined || previous.reprocessed
        ? null
        : canonicalOpponentTag(previous)
    if (currentSession && tag !== previousTag) {
      if (previousTag !== null) {
        this.#sessionTags.set(
          previousTag,
          Math.max(0, (this.#sessionTags.get(previousTag) ?? 1) - 1),
        )
      }
      if (tag !== null) this.#sessionTags.set(tag, (this.#sessionTags.get(tag) ?? 0) + 1)
      this.#sessionRepeats = new Set(
        [...this.#sessionTags].filter(([, count]) => count > 1).map(([key]) => key),
      )
    }
    if (this.#journal !== null) {
      const day = localCalendarDay(new Date(result.timestamp))
      const today = localCalendarDay(this.now())
      const earlier =
        tag === null || day !== today
          ? undefined
          : this.#journal.encounters.findLast(
              (entry) =>
                entry.tag === tag &&
                entry.resultId !== result.id &&
                localCalendarDay(new Date(entry.at)) === today &&
                Date.parse(entry.at) <= Date.parse(result.timestamp),
            )
      result = MonitorResultSchema.parse({
        ...result,
        repeat:
          earlier === undefined
            ? null
            : {
                previousAt: earlier.at,
                previousResultId: earlier.resultId,
                localDay: today,
              },
      })
      this.#journal.encounters = this.#journal.encounters.filter(
        (entry) => entry.resultId !== result.id,
      )
      if (tag !== null)
        this.#journal.encounters.push({
          tag,
          day,
          at: result.timestamp,
          resultId: result.id,
        })
      this.#journal.results = [
        result,
        ...history.filter((entry) => entry.id !== result.id),
      ].slice(0, HISTORY_LIMIT)
    }
    this.patch({
      stats,
      results: [
        result,
        ...this.#view.results.filter((entry) => entry.id !== result.id),
      ].slice(0, 20),
    })
    this.persistJournal()
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

  private failRun(
    generation: number,
    userId: string,
    contextGeneration: number,
    error: ApplicationError,
  ): void {
    if (
      !this.isCurrent(generation, userId, contextGeneration) ||
      this.#view.state === 'STOPPING' ||
      this.#view.state === 'STOPPED' ||
      this.#view.state === 'FAILED'
    ) {
      return
    }
    if (RECOVERABLE_SOURCE_CODES[error.code] && this.#view.runIntent) {
      ++this.#generation
      this.#runController.abort()
      this.#ocrController?.abort()
      this.#pendingAction = null
      this.#ocrActive = false
      this.clearRetry()
      this.waitForSource(publicError(error))
      void this.process.stop()
      return
    }
    ++this.#generation
    this.#ocrController?.abort()
    this.#pendingAction = null
    this.#ocrActive = false
    this.transition('FAILED', { error: publicError(error), runIntent: false })
    this.clearRetry()
    this.finalizeSession('failed')
    void this.process.stop()
  }

  private assertCurrent(
    generation: number,
    userId: string | null,
    contextGeneration: number,
  ): void {
    if (
      generation !== this.#generation ||
      this.#runController.signal.aborted ||
      !this.isUserContextCurrent(userId, contextGeneration)
    ) {
      throw new ApplicationError('MONITOR_CANCELLED', 'Monitor start was cancelled')
    }
  }

  private assertUserContext(userId: string, contextGeneration: number): void {
    if (!this.isUserContextCurrent(userId, contextGeneration)) {
      throw new ApplicationError(
        'MONITOR_CONTEXT_STALE',
        'The monitor user context changed during the operation',
      )
    }
  }

  private isCurrent(
    generation: number,
    userId: string | null,
    contextGeneration: number,
  ): boolean {
    return (
      generation === this.#generation &&
      !this.#runController.signal.aborted &&
      this.isUserContextCurrent(userId, contextGeneration)
    )
  }

  private isRuntimeCurrent(
    generation: number,
    userId: string,
    contextGeneration: number,
  ): boolean {
    return (
      this.isCurrent(generation, userId, contextGeneration) &&
      ['STARTING', 'READY'].includes(this.#view.state)
    )
  }

  private isUserContextCurrent(
    userId: string | null,
    contextGeneration: number,
  ): boolean {
    return (
      contextGeneration === this.#userContextGeneration &&
      userId === this.#userContextId &&
      userId === (this.auth.getView().user?.id ?? null)
    )
  }

  private clearRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    this.#retryTimer = null
    this.#retry = null
  }

  private cancelRecovery(): void {
    if (this.#recoveryTimer !== null) clearTimeout(this.#recoveryTimer)
    this.#recoveryTimer = null
  }

  private waitForSource(error: MonitorView['error']): void {
    this.cancelRecovery()
    this.transition('WAITING_SOURCE', {
      error,
      search: null,
      readiness: { ...this.#view.readiness, sourceAvailable: false },
    })
    const generation = this.#generation
    const delay = SOURCE_RECOVERY_DELAYS[this.#recoveryAttempt++] ?? 15_000
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null
      if (
        generation === this.#generation &&
        this.#view.runIntent &&
        this.#view.state === 'WAITING_SOURCE'
      )
        void this.start()
    }, delay)
    this.#recoveryTimer.unref()
  }

  private sessionSnapshot(): MonitorSession | null {
    const session = this.#view.session
    if (session?.endedAt !== null) return session
    let repeatEncounters = 0
    for (const count of this.#sessionTags.values())
      repeatEncounters += Math.max(0, count - 1)
    return {
      ...session,
      stats: { ...this.#view.stats },
      durationMs: Math.max(0, this.now().getTime() - Date.parse(session.startedAt)),
      repeatEncounters,
      distinctRepeatedOpponents: this.#sessionRepeats.size,
    }
  }

  private finalizeSession(reason: NonNullable<MonitorSession['stopReason']>): void {
    const session = this.sessionSnapshot()
    if (session?.endedAt !== null) return
    const summary: MonitorSession = {
      ...session,
      endedAt: this.now().toISOString(),
      stopReason: reason,
    }
    this.patch({ session: summary, summary })
    if (this.#journal !== null) {
      this.#journal.sessions.push(summary)
      this.persistJournal()
    }
  }

  private async loadJournal(userId: string, contextGeneration: number): Promise<void> {
    if (this.#journal?.userId === userId && this.#journalWritable) return
    let journal: MonitorJournal
    try {
      journal =
        this.journalRepository === undefined
          ? { schemaVersion: 1, userId, results: [], encounters: [], sessions: [] }
          : await this.journalRepository.load(userId)
    } catch {
      if (
        this.isUserContextCurrent(userId, contextGeneration) &&
        !(this.#journal?.userId === userId && this.#journalWritable)
      ) {
        if (this.#journal?.userId !== userId)
          this.#journal = {
            schemaVersion: 1,
            userId,
            results: [],
            encounters: [],
            sessions: [],
          }
        this.patch({
          historyError: {
            code: 'HISTORY_STORAGE_FAILED',
            message:
              'Не удалось прочитать историю сессий. Новые записи пока хранятся только в памяти.',
          },
        })
      }
      return
    }
    if (!this.isUserContextCurrent(userId, contextGeneration)) return
    if (this.#journal?.userId === userId && this.#journalWritable) return
    const memory = this.#journal
    if (memory?.userId === userId) {
      if (memory.results.length > 0) {
        const results = new Map(journal.results.map((entry) => [entry.id, entry]))
        for (const entry of memory.results) results.set(entry.id, entry)
        journal.results = [...results.values()].sort(
          (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
        )
      }
      if (memory.encounters.length > 0) {
        const encounters = new Map(
          journal.encounters.map((entry) => [entry.resultId, entry]),
        )
        for (const entry of memory.encounters) encounters.set(entry.resultId, entry)
        journal.encounters = [...encounters.values()].sort(
          (a, b) => Date.parse(a.at) - Date.parse(b.at),
        )
      }
      if (memory.sessions.length > 0) {
        const sessions = new Map(
          journal.sessions.map((entry) => [entry.sessionId, entry]),
        )
        for (const entry of memory.sessions) sessions.set(entry.sessionId, entry)
        journal.sessions = [...sessions.values()].sort(
          (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
        )
      }
    }
    pruneJournal(journal, this.now())
    this.#journal = journal
    this.#journalWritable = true
    this.patch({ historyError: null })
  }

  private persistJournal(): void {
    const journal = this.#journal
    if (
      journal === null ||
      !this.#journalWritable ||
      this.journalRepository === undefined
    )
      return
    pruneJournal(journal, this.now())
    const generation = this.#userContextGeneration
    const repository = this.journalRepository
    const snapshot = {
      ...journal,
      results: [...journal.results],
      encounters: [...journal.encounters],
      sessions: [...journal.sessions],
    }
    this.#journalWrite = Promise.resolve()
      .then(() => repository.save(snapshot))
      .catch(() => {
        if (this.isUserContextCurrent(journal.userId, generation)) {
          this.patch({
            historyError: {
              code: 'HISTORY_STORAGE_FAILED',
              message: 'Не удалось сохранить историю сессий.',
            },
          })
        }
      })
  }

  private transition(state: MonitorState, patch: Partial<MonitorView> = {}): void {
    if (!TRANSITIONS[this.#view.state].includes(state)) {
      throw new Error(`Invalid monitor transition: ${this.#view.state} -> ${state}`)
    }
    this.patch({ ...patch, state })
  }

  private patch(patch: Partial<MonitorView>): void {
    this.#view = MonitorViewSchema.parse({ ...this.#view, ...patch })
    for (const listener of this.#viewListeners) {
      try {
        listener(this.getCurrentView())
      } catch {
        /* One-way projection. */
      }
    }
  }

  private redactedView(authenticated: boolean): MonitorView {
    return MonitorViewSchema.parse({
      ...this.#view,
      seq: ++this.#viewSeq,
      preferences: DEFAULT_MONITOR_PREFERENCES,
      readiness: {
        authenticated,
        captureConfigured: false,
        sourceAvailable: null,
      },
      stats: EMPTY_STATS,
      results: [],
      runIntent: false,
      search: null,
      session: null,
      summary: null,
      historyError: null,
      geometry: null,
    })
  }
}
