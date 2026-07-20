import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'
import { hasStreamerRole } from '../../../shared/models/auth'
import {
  OverlaySettingsSchema,
  PredictionPreferencesSchema,
  StreamerViewSchema,
  StreamTitleSettingsSchema,
  type OverlaySettings,
  type OverlayUrlKind,
  type PredictionPreferences,
  type StreamerView,
  type StreamTitleSettings,
} from '../../../shared/models/streamer'
import type { PredictionPreferencesRepository } from '../infrastructure/prediction-preferences-repository'
import { DEFAULT_PREDICTION_PREFERENCES } from '../infrastructure/prediction-preferences-repository'
import type { PredictionResultConfigurationRepository } from '../infrastructure/prediction-result-configuration-repository'
import { predictionResultMatchesCapture } from '../../../shared/models/prediction-result'
import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { AuthSession } from './auth-session'
import type { AuthenticatedApiClient } from './api-client'
import type { MonitorSupervisor } from './monitor-supervisor'
import type { PredictionCoordinator } from './prediction-coordinator'
import {
  DEFAULT_OVERLAY_SETTINGS,
  DEFAULT_TITLE_SETTINGS,
  overlayToServer,
  parseOverlay,
  parsePredictions,
  parseTitle,
  parseTwitch,
  recommendedSizes,
  titleToServer,
} from './streamer-adapters'

const UnknownSchema = z.unknown()
const CommandSuccessSchema = z.object({ success: z.literal(true) }).loose()
const AuthConnectSchema = z
  .object({ auth_url: z.string().max(4096), success: z.boolean().optional() })
  .loose()

export interface StreamerExternalShell {
  openExternal: (url: string) => Promise<void>
}
export interface StreamerClipboard {
  writeText: (text: string) => void
}

function initialView(): StreamerView {
  return StreamerViewSchema.parse({
    access: { allowed: false, reason: 'Streamer role is required' },
    twitch: { connected: false, username: null, polling: false },
    predictions: {
      active: false,
      state: 'idle',
      runtimeState: 'stopped',
      settings: DEFAULT_PREDICTION_PREFERENCES,
      statistics: {
        total: 0,
        successful: 0,
        successRate: 0,
        currentWinStreak: 0,
        activeTitle: null,
      },
      requirements: {
        twitchConnected: false,
        mainMonitorConfigured: false,
        mainMonitorRunning: false,
        resultConfigured: false,
      },
    },
    title: {
      settings: DEFAULT_TITLE_SETTINGS,
      accounts: [],
      session: null,
      recentResults: [],
      previewTitle: '',
      twitchOnline: false,
    },
    deckSharing: { enabled: false },
    overlay: {
      settings: DEFAULT_OVERLAY_SETTINGS,
      urlsAvailable: { stats: false, opponent: false },
      maskedUrls: { stats: null, opponent: null },
      recommendedSizes: recommendedSizes(DEFAULT_OVERLAY_SETTINGS),
    },
    refresh: { state: 'idle', errors: [], refreshedAt: null },
  })
}

function publicFailure(
  section: StreamerView['refresh']['errors'][number]['section'],
  error: unknown,
) {
  return {
    section,
    error:
      error instanceof ApplicationError
        ? { code: error.code, message: error.message }
        : { code: 'STREAMER_REFRESH_FAILED', message: `Could not refresh ${section}` },
  }
}

export class StreamerService {
  #view = initialView()
  #urls: Record<OverlayUrlKind, string | null> = { stats: null, opponent: null }
  #refreshPromise: Promise<StreamerView> | null = null
  #refreshController = new AbortController()
  #generation = 0
  #mutationQueue: Promise<void> = Promise.resolve()
  #sectionActive = false
  #pollTimer: ReturnType<typeof setTimeout> | null = null
  #oauthPollsRemaining = 0
  #lifecycleGeneration = 0

  constructor(
    private readonly auth: AuthSession,
    private readonly api: AuthenticatedApiClient,
    private readonly preferences: PredictionPreferencesRepository,
    private readonly resultConfigurations: PredictionResultConfigurationRepository,
    private readonly captureConfigurations: CaptureConfigurationRepository,
    private readonly monitor: MonitorSupervisor,
    private readonly predictions: PredictionCoordinator,
    private readonly shell: StreamerExternalShell,
    private readonly clipboard: StreamerClipboard,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getView(): StreamerView {
    return this.#view
  }

  ensureAccess(): void {
    this.assertAccess()
  }

  start(): void {
    ++this.#lifecycleGeneration
    this.predictions.startLifecycle()
  }

  async stop(): Promise<void> {
    ++this.#lifecycleGeneration
    this.#sectionActive = false
    this.#oauthPollsRemaining = 0
    this.cancelRefresh()
    this.stopPolling()
    await this.predictions.shutdown()
    this.#view = initialView()
    this.#urls = { stats: null, opponent: null }
  }

  setSectionActive(active: boolean): StreamerView {
    this.#sectionActive = active
    if (active) {
      void this.refresh()
      this.schedulePoll(15_000)
    } else if (this.#oauthPollsRemaining === 0) {
      this.stopPolling()
      this.cancelRefresh()
    }
    return this.#view
  }

  refresh(): Promise<StreamerView> {
    if (this.#refreshPromise !== null) return this.#refreshPromise
    const generation = ++this.#generation
    this.#refreshController.abort()
    this.#refreshController = new AbortController()
    const operation = this.runRefresh(generation, this.#refreshController.signal).finally(
      () => {
        if (this.#refreshPromise === operation) this.#refreshPromise = null
      },
    )
    this.#refreshPromise = operation
    return operation
  }

  connectTwitch(): Promise<StreamerView> {
    return this.mutate(async () => {
      this.assertAccess()
      const result = await this.api.request({
        method: 'GET',
        path: '/api/streamer/auth/connect',
        schema: AuthConnectSchema,
      })
      if (!result.ok) throw new ApplicationError(result.error.code, result.error.message)
      const url = new URL(result.data.auth_url)
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'id.twitch.tv' ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/oauth2/authorize'
      ) {
        throw new ApplicationError(
          'TWITCH_OAUTH_URL_REJECTED',
          'Server returned an untrusted Twitch authorization URL',
        )
      }
      await this.shell.openExternal(url.href)
      this.#oauthPollsRemaining = 12
      this.patch({ twitch: { ...this.#view.twitch, polling: true } })
      this.schedulePoll(2_000)
    })
  }

  disconnectTwitch(): Promise<StreamerView> {
    return this.mutate(async () => {
      await this.request('POST', '/api/streamer/auth/disconnect')
      this.#oauthPollsRemaining = 0
      this.patch({ twitch: { connected: false, username: null, polling: false } })
    })
  }

  startPredictions(settings: PredictionPreferences): Promise<StreamerView> {
    return this.mutate(async () => {
      const user = this.assertAccess()
      const parsed = PredictionPreferencesSchema.parse(settings)
      await this.preferences.save(user.id, parsed)
      await this.predictions.start(parsed)
    })
  }

  stopPredictions(): Promise<StreamerView> {
    return this.mutate(() => this.predictions.stop())
  }

  updateTitle(settings: StreamTitleSettings): Promise<StreamerView> {
    return this.mutate(async () => {
      const parsed = StreamTitleSettingsSchema.parse(settings)
      await this.request('POST', '/api/streamer/title/settings', titleToServer(parsed))
    })
  }

  setTitleEnabled(enabled: boolean): Promise<StreamerView> {
    return this.mutate(() =>
      this.request('POST', '/api/streamer/title/enabled', { enabled }),
    )
  }

  setTitlePaused(paused: boolean): Promise<StreamerView> {
    return this.mutate(() =>
      this.request('POST', '/api/streamer/title/pause', { paused }),
    )
  }

  addTitleAccount(tag: string, alias: string): Promise<StreamerView> {
    return this.mutate(() =>
      this.request('POST', '/api/streamer/title/accounts', { tag, alias }),
    )
  }

  removeTitleAccount(tag: string): Promise<StreamerView> {
    return this.mutate(() =>
      this.request(
        'DELETE',
        `/api/streamer/title/accounts/${encodeURIComponent(tag)}` as `/api/${string}`,
      ),
    )
  }

  titleCommand(command: 'reset' | 'undo' | 'restore-title'): Promise<StreamerView> {
    return this.mutate(() => this.request('POST', `/api/streamer/title/${command}`))
  }

  setDeckSharing(enabled: boolean): Promise<StreamerView> {
    return this.mutate(() =>
      this.request('POST', '/api/streamer/settings/deck-sharing', { enabled }),
    )
  }

  updateOverlay(settings: OverlaySettings): Promise<StreamerView> {
    return this.mutate(async () => {
      const parsed = OverlaySettingsSchema.parse(settings)
      await this.request(
        'PUT',
        '/api/streamer/opponent-widget/settings',
        overlayToServer(parsed),
      )
    })
  }

  rotateOverlayToken(): Promise<StreamerView> {
    return this.mutate(() =>
      this.request('POST', '/api/streamer/opponent-widget/reset-token'),
    )
  }

  copyOverlayUrl(kind: OverlayUrlKind): StreamerView {
    this.assertAccess()
    const url = this.#urls[kind]
    if (url === null)
      throw new ApplicationError(
        'OVERLAY_URL_UNAVAILABLE',
        'The OBS URL is not available',
      )
    this.clipboard.writeText(url)
    return this.#view
  }

  private async runRefresh(
    generation: number,
    signal: AbortSignal,
  ): Promise<StreamerView> {
    const authView = this.auth.getView()
    if (!hasStreamerRole(authView) || authView.user === null) {
      if (generation === this.#generation) this.#view = initialView()
      return this.#view
    }
    this.patch({
      access: { allowed: true, reason: null },
      refresh: { ...this.#view.refresh, state: 'refreshing', errors: [] },
    })
    const userId = authView.user.id
    const predictionObservationGeneration = this.predictions.observationGeneration
    const captureProfiles = await this.captureConfigurations
      .list(userId)
      .catch(() => null)
    const local = await Promise.allSettled([
      this.preferences.load(userId),
      captureProfiles === null
        ? Promise.resolve(null)
        : this.resultConfigurations.load(userId, captureProfiles.activeProfileId),
      this.captureConfigurations.load(userId),
      this.monitor.getView(),
    ])
    const localErrors: StreamerView['refresh']['errors'] = []
    const localPreferences =
      local[0].status === 'fulfilled'
        ? local[0].value
        : { ...DEFAULT_PREDICTION_PREFERENCES }
    if (local[0].status === 'rejected')
      localErrors.push(publicFailure('predictions', local[0].reason))
    const loadedResultConfig = local[1].status === 'fulfilled' ? local[1].value : null
    if (local[1].status === 'rejected')
      localErrors.push(publicFailure('predictions', local[1].reason))
    const captureConfig = local[2].status === 'fulfilled' ? local[2].value : null
    if (local[2].status === 'rejected')
      localErrors.push(publicFailure('predictions', local[2].reason))
    const activeCapture = captureProfiles?.profiles.find(
      (profile) => profile.profileId === captureProfiles.activeProfileId,
    )
    const resultConfig =
      loadedResultConfig !== null &&
      activeCapture !== undefined &&
      predictionResultMatchesCapture(loadedResultConfig, activeCapture)
        ? loadedResultConfig
        : null
    const monitorView =
      local[3].status === 'fulfilled' ? local[3].value : { state: 'FAILED' as const }
    if (local[3].status === 'rejected')
      localErrors.push(publicFailure('predictions', local[3].reason))
    const predictionRequest = Promise.all([
      this.api.request({
        method: 'GET',
        path: '/api/streamer/bot/status',
        schema: UnknownSchema,
        signal,
      }),
      this.api.request({
        method: 'GET',
        path: '/api/streamer/result-config',
        schema: UnknownSchema,
        signal,
      }),
    ]).then(([status, result]) => (!status.ok ? status : !result.ok ? result : status))
    const requests = await Promise.allSettled([
      this.api.request({
        method: 'GET',
        path: '/api/streamer/auth/status',
        schema: UnknownSchema,
        signal,
      }),
      predictionRequest,
      this.api.request({
        method: 'GET',
        path: '/api/streamer/title/status',
        schema: UnknownSchema,
        signal,
      }),
      this.api.request({
        method: 'GET',
        path: '/api/streamer/settings/deck-sharing',
        schema: UnknownSchema,
        signal,
      }),
      this.api.request({
        method: 'GET',
        path: '/api/streamer/opponent-widget/status',
        schema: UnknownSchema,
        signal,
      }),
    ])
    if (generation !== this.#generation || signal.aborted) return this.#view
    const sections = ['twitch', 'predictions', 'title', 'deckSharing', 'overlay'] as const
    const errors: StreamerView['refresh']['errors'] = [...localErrors]
    let next = this.#view
    for (let index = 0; index < requests.length; index += 1) {
      const settled = requests[index]
      const section = sections[index]
      if (settled === undefined || section === undefined) continue
      if (settled.status === 'rejected') {
        errors.push(publicFailure(section, settled.reason))
        continue
      }
      if (!settled.value.ok) {
        errors.push(
          publicFailure(
            section,
            new ApplicationError(settled.value.error.code, settled.value.error.message),
          ),
        )
        continue
      }
      const value = settled.value.data
      if (section === 'twitch')
        next = {
          ...next,
          twitch: { ...parseTwitch(value), polling: this.#oauthPollsRemaining > 0 },
        }
      else if (section === 'predictions') {
        const parsed = parsePredictions(value, localPreferences)
        this.predictions.observeServerState(
          parsed.active,
          userId,
          predictionObservationGeneration,
        )
        next = { ...next, predictions: { ...next.predictions, ...parsed } }
      } else if (section === 'title') next = { ...next, title: parseTitle(value) }
      else if (section === 'deckSharing') {
        const input =
          value !== null && typeof value === 'object'
            ? (value as Record<string, unknown>)
            : {}
        const settings =
          input['settings'] !== null && typeof input['settings'] === 'object'
            ? (input['settings'] as Record<string, unknown>)
            : {}
        next = { ...next, deckSharing: { enabled: settings['enabled'] === true } }
      } else {
        const parsed = parseOverlay(value)
        this.#urls = parsed.urls
        next = {
          ...next,
          overlay: {
            settings: parsed.settings,
            urlsAvailable: {
              stats: parsed.urls.stats !== null,
              opponent: parsed.urls.opponent !== null,
            },
            maskedUrls: {
              stats:
                parsed.urls.stats === null ? null : 'OBS stats URL available (hidden)',
              opponent:
                parsed.urls.opponent === null
                  ? null
                  : 'OBS opponent URL available (hidden)',
            },
            recommendedSizes: recommendedSizes(parsed.settings),
          },
        }
      }
    }
    const boundedErrors = errors
      .filter(
        (item, index, values) =>
          values.findIndex((candidate) => candidate.section === item.section) === index,
      )
      .slice(0, 5)
    next = {
      ...next,
      access: { allowed: true, reason: null },
      predictions: {
        ...next.predictions,
        runtimeState: this.predictions.state,
        requirements: {
          twitchConnected: next.twitch.connected,
          mainMonitorConfigured: captureConfig !== null,
          mainMonitorRunning: monitorView.state === 'READY',
          resultConfigured: resultConfig !== null,
        },
      },
      refresh: {
        state:
          boundedErrors.length === 0
            ? 'ready'
            : boundedErrors.length === 5
              ? 'failed'
              : 'partial',
        errors: boundedErrors,
        refreshedAt: this.now().toISOString(),
      },
    }
    this.#view = StreamerViewSchema.parse(next)
    return this.#view
  }

  private mutate(operation: () => Promise<unknown>): Promise<StreamerView> {
    const lifecycleGeneration = this.#lifecycleGeneration
    const result = this.#mutationQueue.then(async () => {
      if (lifecycleGeneration !== this.#lifecycleGeneration) {
        throw new ApplicationError(
          'STREAMER_CANCELLED',
          'Streamer operation was cancelled',
        )
      }
      this.assertAccess()
      await operation()
      if (lifecycleGeneration !== this.#lifecycleGeneration) {
        throw new ApplicationError(
          'STREAMER_CANCELLED',
          'Streamer operation was cancelled',
        )
      }
      this.cancelRefresh()
      await this.refresh()
    })
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result.then(() => this.#view)
  }

  private async request(
    method: 'POST' | 'PUT' | 'DELETE',
    path: `/api/${string}`,
    body?: unknown,
  ): Promise<void> {
    const result = await this.api.request({
      method,
      path,
      body,
      schema: CommandSuccessSchema,
    })
    if (!result.ok) {
      if (typeof result.error.status === 'number' && result.error.status >= 200) {
        throw new ApplicationError(
          'STREAMER_COMMAND_FAILED',
          'The server did not confirm the requested change',
        )
      }
      throw new ApplicationError(result.error.code, result.error.message)
    }
  }

  private assertAccess() {
    const view = this.auth.getView()
    if (!hasStreamerRole(view) || view.user === null)
      throw new ApplicationError('STREAMER_ROLE_REQUIRED', 'Streamer role is required')
    return view.user
  }

  private patch(patch: Partial<StreamerView>): void {
    this.#view = StreamerViewSchema.parse({ ...this.#view, ...patch })
  }

  private cancelRefresh(): void {
    ++this.#generation
    this.#refreshController.abort()
    this.#refreshPromise = null
  }

  private schedulePoll(delay: number): void {
    this.stopPolling()
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null
      if (!this.#sectionActive && this.#oauthPollsRemaining === 0) return
      void this.refresh()
        .catch(() => this.#view)
        .finally(() => {
          if (this.#oauthPollsRemaining > 0) {
            this.#oauthPollsRemaining -= 1
            if (this.#view.twitch.connected) this.#oauthPollsRemaining = 0
          }
          if (this.#oauthPollsRemaining === 0 && this.#view.twitch.polling)
            this.patch({ twitch: { ...this.#view.twitch, polling: false } })
          if (this.#sectionActive || this.#oauthPollsRemaining > 0)
            this.schedulePoll(this.#oauthPollsRemaining > 0 ? 2_000 : 15_000)
        })
    }, delay)
  }

  private stopPolling(): void {
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer)
    this.#pollTimer = null
  }
}
