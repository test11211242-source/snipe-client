import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  AccountErrorCodeSchema,
  type AccountMutationResult,
  StreamerCommandSchema,
  StreamerCommandErrorCodeSchema,
  type StreamerCommandResult,
  StreamerReadinessSchema,
  type StreamerReadiness,
} from '../../../shared/contracts/streamer-ipc'
import { hasStreamerRole } from '../../../shared/models/auth'
import {
  OverlaySettingsSchema,
  PredictionPreferencesSchema,
  PredictionStatusSchema,
  StreamTitlePreviewSchema,
  StreamerViewSchema,
  StreamTitleSettingsSchema,
  GameAccountTagSchema,
  type OverlaySettings,
  type OverlayUrlKind,
  type PredictionPreferences,
  type StreamerView,
  type StreamTitleSettings,
  type StreamTitlePreview,
} from '../../../shared/models/streamer'
import type { PredictionPreferencesRepository } from '../infrastructure/prediction-preferences-repository'
import { DEFAULT_PREDICTION_PREFERENCES } from '../infrastructure/prediction-preferences-repository'
import type { PredictionResultConfigurationRepository } from '../infrastructure/prediction-result-configuration-repository'
import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { AuthSession } from './auth-session'
import type { AuthenticatedApiClient } from './api-client'
import type { MonitorSupervisor } from './monitor-supervisor'
import {
  getPredictionProfileReadiness,
  type PredictionCoordinator,
} from './prediction-coordinator'
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

const CommandSuccessSchema = z.object({ success: z.literal(true) }).loose()
const TitlePreviewResponseSchema = z
  .object({
    success: z.literal(true),
    preview_title: z.string().max(300),
    character_count: z.number().int().nonnegative().max(300),
    warnings: z.array(z.string().min(1).max(300)).max(8),
  })
  .loose()
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
    _resultConfigurations: PredictionResultConfigurationRepository,
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

  async getReadiness(): Promise<StreamerReadiness> {
    const generation = this.auth.getContextGeneration()
    const user = this.auth.getView().user
    const [capture, monitor] = await Promise.allSettled([
      user === null
        ? Promise.resolve(null)
        : this.captureConfigurations.getActive(user.id),
      this.monitor.getView(),
    ])
    const active = capture.status === 'fulfilled' ? capture.value : null
    const profileReady = getPredictionProfileReadiness(
      active?.profile.configuration ?? null,
    ).ready
    if (generation !== this.auth.getContextGeneration())
      throw new ApplicationError('STREAMER_CANCELLED', 'Readiness was cancelled')
    return StreamerReadinessSchema.parse({
      twitchConnected:
        this.#view.refresh.state === 'idle' ||
        this.#view.refresh.errors.some((entry) => entry.section === 'twitch')
          ? null
          : this.#view.twitch.connected,
      accountsCount:
        !this.#view.access.allowed ||
        this.#view.refresh.state === 'idle' ||
        this.#view.refresh.errors.some((entry) => entry.section === 'title')
          ? null
          : this.#view.title.accounts.filter((account) => account.enabled).length,
      monitoring:
        monitor.status === 'fulfilled'
          ? monitor.value.runIntent && monitor.value.state === 'READY'
          : null,
      captureConfigured: capture.status === 'fulfilled' ? active !== null : null,
      resultZonesConfigured: profileReady,
      activeProfileId: active?.profile.profileId ?? null,
    })
  }

  async execute(raw: unknown): Promise<StreamerCommandResult> {
    const generation = this.auth.getContextGeneration()
    let titleApplication: 'not_requested' | 'unconfirmed' | 'failed' = 'not_requested'
    try {
      const parsed = StreamerCommandSchema.safeParse(raw)
      if (!parsed.success)
        return { ok: false, error: { code: 'VALIDATION_FAILED', detail: null } }
      const command = parsed.data
      this.assertAccess()
      let preview: StreamTitlePreview | null = null
      const warnings: Extract<StreamerCommandResult, { ok: true }>['warnings'] = []
      switch (command.action) {
        case 'twitch.connect':
          await this.connectTwitch()
          break
        case 'twitch.disconnect':
          await this.disconnectTwitch()
          break
        case 'predictions.start':
          await this.startPredictions(command.settings)
          break
        case 'predictions.stop':
          await this.stopPredictions()
          break
        case 'title.save':
          await this.updateTitle(command.settings)
          break
        case 'title.preview':
          preview = await this.previewTitle(command.settings)
          break
        case 'title.apply':
          titleApplication = 'unconfirmed'
          await this.mutate(async () => {
            if (!this.#view.twitch.connected || this.#view.title.session === null)
              throw new ApplicationError(
                'TITLE_APPLY_UNAVAILABLE',
                'Connect Twitch and start a stream session before applying a title',
              )
            await this.request(
              'POST',
              '/api/streamer/title/settings',
              titleToServer({ ...command.settings, enabled: true, paused: false }),
            )
          })
          warnings.push('TITLE_APPLICATION_UNCONFIRMED')
          break
        case 'title.enabled':
          await this.setTitleEnabled(command.enabled)
          break
        case 'title.paused':
          await this.setTitlePaused(command.paused)
          break
        case 'title.reset':
          await this.titleCommand('reset')
          break
        case 'title.undo':
          await this.titleCommand('undo')
          break
        case 'title.restore':
          await this.titleCommand('restore-title')
          break
        case 'chat.toggle':
          await this.setDeckSharing(command.enabled)
          break
        case 'widget.settings':
          await this.updateOverlay(command.settings)
          break
        case 'widget.enabled':
          await this.mutate(async () => {
            this.cancelRefresh()
            await this.refresh()
            if (generation !== this.auth.getContextGeneration())
              throw new ApplicationError(
                'STREAMER_CANCELLED',
                'Widget operation was cancelled',
              )
            if (this.#view.refresh.errors.some((entry) => entry.section === 'overlay'))
              throw new ApplicationError(
                'INVALID_RESPONSE',
                'Current widget settings are unavailable',
              )
            await this.request(
              'PUT',
              '/api/streamer/opponent-widget/settings',
              overlayToServer({
                ...this.#view.overlay.settings,
                enabled: command.enabled,
              }),
            )
          })
          break
        case 'widget.resetToken':
          await this.rotateOverlayToken()
          break
        case 'widget.copy':
          this.copyOverlayUrl(command.kind)
          break
        case 'accounts.remove':
          await this.removeTitleAccount(command.tag)
          break
        case 'accounts.add':
        case 'accounts.reenable': {
          const tag = GameAccountTagSchema.safeParse(command.tag)
          if (!tag.success)
            return { ok: false, error: { code: 'ACCOUNT_TAG_INVALID', detail: null } }
          let alias: string
          if (command.action === 'accounts.add') alias = command.alias
          else {
            await this.refresh()
            if (generation !== this.auth.getContextGeneration())
              throw new ApplicationError(
                'STREAMER_CANCELLED',
                'Account operation was cancelled',
              )
            if (this.#view.refresh.errors.some((entry) => entry.section === 'title'))
              return { ok: false, error: { code: 'INVALID_RESPONSE', detail: null } }
            const account = this.#view.title.accounts.find(
              (entry) => GameAccountTagSchema.safeParse(entry.tag).data === tag.data,
            )
            if (account === undefined)
              return { ok: false, error: { code: 'ACCOUNT_NOT_FOUND', detail: null } }
            alias = account.alias
          }
          const result = await this.addTitleAccount(tag.data, alias)
          if (generation !== this.auth.getContextGeneration())
            throw new ApplicationError(
              'STREAMER_CANCELLED',
              'Account operation was cancelled',
            )
          if (!result.ok) return result
          if (result.warning !== null) warnings.push(result.warning)
          break
        }
      }
      if (generation !== this.auth.getContextGeneration())
        throw new ApplicationError(
          'STREAMER_CANCELLED',
          'Streamer operation was cancelled',
        )
      if (
        (this.#view.refresh.state === 'partial' ||
          this.#view.refresh.state === 'failed') &&
        !warnings.includes('REFRESH_FAILED')
      )
        warnings.push('REFRESH_FAILED')
      return { ok: true, view: this.getView(), preview, warnings, titleApplication }
    } catch (error) {
      if (generation !== this.auth.getContextGeneration())
        return { ok: false, error: { code: 'STREAMER_CANCELLED', detail: null } }
      if (
        error instanceof ApplicationError &&
        error.code === 'TITLE_SAVED_APPLY_FAILED'
      ) {
        await this.refresh().catch(() => undefined)
        if (generation !== this.auth.getContextGeneration())
          return { ok: false, error: { code: 'STREAMER_CANCELLED', detail: null } }
        titleApplication = 'failed'
        return {
          ok: true,
          view: this.getView(),
          preview: null,
          warnings: ['TITLE_UPDATE_FAILED'],
          titleApplication,
        }
      }
      const code = StreamerCommandErrorCodeSchema.safeParse(
        error instanceof ApplicationError ? error.code : 'UNKNOWN',
      )
      return {
        ok: false,
        error: { code: code.success ? code.data : 'UNKNOWN', detail: null },
      }
    }
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
      void this.refresh().catch(() => undefined)
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
      const generation = this.auth.getContextGeneration()
      const result = await this.api.request({
        method: 'GET',
        path: '/api/streamer/auth/connect',
        schema: AuthConnectSchema,
        authContextGuard: () => generation === this.auth.getContextGeneration(),
      })
      if (generation !== this.auth.getContextGeneration())
        throw new ApplicationError(
          'STREAMER_CANCELLED',
          'Twitch connection was cancelled',
        )
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
      this.assertAccess()
      await this.predictions.start(PredictionPreferencesSchema.parse(settings))
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

  async previewTitle(settings: StreamTitleSettings): Promise<StreamTitlePreview> {
    this.assertAccess()
    const parsed = StreamTitleSettingsSchema.parse(settings)
    const generation = this.auth.getContextGeneration()
    const result = await this.api.request({
      method: 'POST',
      path: '/api/streamer/title/preview',
      body: titleToServer(parsed),
      schema: TitlePreviewResponseSchema,
      authContextGuard: () => generation === this.auth.getContextGeneration(),
    })
    if (generation !== this.auth.getContextGeneration())
      throw new ApplicationError('STREAMER_CANCELLED', 'Title preview was cancelled')
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message)
    }
    return StreamTitlePreviewSchema.parse({
      previewTitle: result.data.preview_title,
      characterCount: result.data.character_count,
      warnings: result.data.warnings,
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

  async addTitleAccount(tag: string, alias: string): Promise<AccountMutationResult> {
    const outcome: {
      saved: boolean
      warning: 'TITLE_UPDATE_FAILED' | 'REFRESH_FAILED' | null
      failure: AccountMutationResult | null
    } = { saved: false, warning: null, failure: null }
    try {
      const view = await this.mutate(async () => {
        const generation = this.auth.getContextGeneration()
        const result = await this.api.request({
          method: 'POST',
          path: '/api/streamer/accounts',
          body: { tag, alias },
          schema: CommandSuccessSchema,
          timeoutMs: 30_000,
          authContextGuard: () => generation === this.auth.getContextGeneration(),
        })
        if (generation !== this.auth.getContextGeneration())
          throw new ApplicationError(
            'STREAMER_CANCELLED',
            'Account operation was cancelled',
          )
        if (!result.ok) {
          const code = AccountErrorCodeSchema.safeParse(result.error.code)
          outcome.failure = {
            ok: false,
            error: {
              code: code.success ? code.data : 'UNKNOWN',
              detail: code.success ? result.error.message : null,
            },
          }
          throw new ApplicationError('STREAMER_COMMAND_FAILED', 'Account was not saved')
        }
        outcome.saved = true
        if (result.data['warning'] === 'TITLE_UPDATE_FAILED')
          outcome.warning = 'TITLE_UPDATE_FAILED'
      })
      if (
        view.refresh.errors.some((error) => error.section === 'title') &&
        outcome.warning === null
      ) {
        outcome.warning = 'REFRESH_FAILED'
      }
      return { ok: true, view, warning: outcome.warning }
    } catch (error) {
      if (outcome.saved)
        return {
          ok: true,
          view: this.#view,
          warning: outcome.warning ?? 'REFRESH_FAILED',
        }
      if (outcome.failure !== null) return outcome.failure
      const code = AccountErrorCodeSchema.safeParse(
        error instanceof ApplicationError ? error.code : 'UNKNOWN',
      )
      return {
        ok: false,
        error: { code: code.success ? code.data : 'UNKNOWN', detail: null },
      }
    }
  }

  removeTitleAccount(tag: string): Promise<StreamerView> {
    return this.mutate(() =>
      this.request(
        'DELETE',
        `/api/streamer/accounts/${encodeURIComponent(tag)}` as `/api/${string}`,
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
    const local = await Promise.allSettled([
      this.preferences.load(userId),
      this.captureConfigurations.load(userId),
      this.monitor.getView(),
    ])
    if (!this.isCurrentRefresh(generation, signal)) return this.#view
    const localErrors: StreamerView['refresh']['errors'] = []
    const localPreferences =
      local[0].status === 'fulfilled'
        ? local[0].value
        : { ...DEFAULT_PREDICTION_PREFERENCES }
    if (local[0].status === 'rejected')
      localErrors.push(publicFailure('predictions', local[0].reason))
    const captureConfig = local[1].status === 'fulfilled' ? local[1].value : null
    if (local[1].status === 'rejected')
      localErrors.push(publicFailure('predictions', local[1].reason))
    const monitorView =
      local[2].status === 'fulfilled' ? local[2].value : { state: 'FAILED' as const }
    if (local[2].status === 'rejected')
      localErrors.push(publicFailure('predictions', local[2].reason))
    const predictionRequest = this.api.request({
      method: 'GET',
      path: '/api/streamer/predictions/status',
      schema: PredictionStatusSchema,
      signal,
    })
    const requests = await Promise.allSettled([
      this.api.request({
        method: 'GET',
        path: '/api/streamer/auth/status',
        schema: CommandSuccessSchema,
        signal,
      }),
      predictionRequest,
      this.api.request({
        method: 'GET',
        path: '/api/streamer/title/status',
        schema: CommandSuccessSchema,
        signal,
      }),
      this.api.request({
        method: 'GET',
        path: '/api/streamer/settings/deck-sharing',
        schema: CommandSuccessSchema,
        signal,
      }),
      this.api.request({
        method: 'GET',
        path: '/api/streamer/opponent-widget/status',
        schema: CommandSuccessSchema,
        signal,
      }),
    ])
    if (!this.isCurrentRefresh(generation, signal)) return this.#view
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
      const value = settled.value.data as Record<string, unknown>
      const previous = next
      const previousUrls = this.#urls
      try {
        if (section !== 'predictions') CommandSuccessSchema.parse(value)
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
          const settings =
            value['settings'] !== null && typeof value['settings'] === 'object'
              ? (value['settings'] as Record<string, unknown>)
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
        next = StreamerViewSchema.parse(next)
      } catch (error) {
        next = previous
        this.#urls = previousUrls
        errors.push(publicFailure(section, error))
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
          mainMonitorConfigured: getPredictionProfileReadiness(captureConfig).ready,
          mainMonitorRunning: monitorView.state === 'READY',
          resultConfigured: true,
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
    const authGeneration = this.auth.getContextGeneration()
    const result = this.#mutationQueue.then(async () => {
      if (
        lifecycleGeneration !== this.#lifecycleGeneration ||
        authGeneration !== this.auth.getContextGeneration()
      ) {
        throw new ApplicationError(
          'STREAMER_CANCELLED',
          'Streamer operation was cancelled',
        )
      }
      this.assertAccess()
      await operation()
      if (
        lifecycleGeneration !== this.#lifecycleGeneration ||
        authGeneration !== this.auth.getContextGeneration()
      ) {
        throw new ApplicationError(
          'STREAMER_CANCELLED',
          'Streamer operation was cancelled',
        )
      }
      this.cancelRefresh()
      await this.refresh().catch(() => {
        this.patch({ refresh: { ...this.#view.refresh, state: 'failed' } })
      })
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
    const generation = this.auth.getContextGeneration()
    const result = await this.api.request({
      method,
      path,
      body,
      schema: CommandSuccessSchema,
      authContextGuard: () => generation === this.auth.getContextGeneration(),
    })
    if (generation !== this.auth.getContextGeneration())
      throw new ApplicationError('STREAMER_CANCELLED', 'Streamer operation was cancelled')
    if (!result.ok) {
      if (
        (result.error.code === 'TITLE_SAVED_APPLY_FAILED' ||
          (result.error.status === 502 &&
            result.error.message ===
              'Настройки сохранены, но Twitch не обновил название. Повторите попытку.')) &&
        (path === '/api/streamer/title/settings' ||
          path === '/api/streamer/title/enabled' ||
          path === '/api/streamer/title/pause')
      ) {
        throw new ApplicationError(
          'TITLE_SAVED_APPLY_FAILED',
          'Settings were saved but Twitch did not apply the title',
        )
      }
      if (
        typeof result.error.status === 'number' &&
        result.error.status >= 200 &&
        result.error.status < 300
      ) {
        throw new ApplicationError(
          'STREAMER_COMMAND_FAILED',
          'The server did not confirm the requested change',
        )
      }
      throw new ApplicationError(
        result.error.code === 'TITLE_SAVED_APPLY_FAILED'
          ? 'STREAMER_COMMAND_FAILED'
          : result.error.code,
        result.error.message,
      )
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

  private isCurrentRefresh(generation: number, signal: AbortSignal): boolean {
    return generation === this.#generation && !signal.aborted
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
