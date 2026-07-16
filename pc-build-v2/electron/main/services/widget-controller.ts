import { ApplicationError } from '../../../shared/errors/application-error'
import type { MonitorResult } from '../../../shared/models/monitor'
import {
  WidgetBoundsSchema,
  WidgetSettingsSchema,
  WidgetStatusSchema,
  WidgetViewSchema,
  type WidgetBounds,
  type WidgetResult,
  type WidgetSettings,
  type WidgetStatus,
  type WidgetView,
} from '../../../shared/models/widget'
import type { WidgetSettingsRepository } from '../infrastructure/widget-settings-repository'
import type { WindowCoordinator } from '../windows/window-coordinator'
import type { MonitorSupervisor } from './monitor-supervisor'

const BOUNDS_SAVE_DELAY_MS = 300

function projectResult(result: MonitorResult | null): WidgetResult | null {
  if (result === null) return null
  const base = {
    id: result.id,
    kind: result.kind,
    timestamp: result.timestamp,
    searchedNickname: result.searchedNickname,
  }
  if (result.kind === 'player_found') {
    return {
      ...base,
      kind: 'player_found',
      player: result.player,
      decks: result.decks.map((deck) => ({
        label: deck.label,
        cards: deck.cards.map((card) => ({
          name: card.name,
          level: card.level,
          evolutionLevel: card.evolutionLevel,
          hasImage: card.iconUrl !== null,
        })),
      })),
    }
  }
  return { ...base, kind: result.kind, message: result.message }
}

export class WidgetController {
  #userId: string | null = null
  #settings: WidgetSettings | null = null
  #disposeMonitor: (() => void) | null = null
  #disposeBounds: (() => void) | null = null
  #boundsTimer: ReturnType<typeof setTimeout> | null = null
  #generation = 0
  #settingsMutation: Promise<void> = Promise.resolve()
  readonly #autoOpenedIds = new Set<string>()
  readonly #autoOpenedOrder: string[] = []
  readonly #autoOpeningIds = new Set<string>()

  constructor(
    private readonly monitor: Pick<
      MonitorSupervisor,
      'getLatestResult' | 'subscribeResults'
    >,
    private readonly repository: WidgetSettingsRepository,
    private readonly windows: WindowCoordinator,
  ) {}

  async start(userId: string): Promise<void> {
    if (this.#userId === userId && this.#settings !== null) return
    if (this.#userId !== null) await this.stop('auth-transition')
    const generation = ++this.#generation
    const settings = await this.repository.load(userId)
    if (generation !== this.#generation) return
    this.#settings = settings
    this.#userId = userId
    this.#autoOpenedIds.clear()
    this.#autoOpenedOrder.length = 0
    this.#autoOpeningIds.clear()
    const current = this.monitor.getLatestResult()
    if (current !== null) this.rememberResult(current.id)
    this.#disposeMonitor = this.monitor.subscribeResults((result) =>
      this.acceptResult(result),
    )
    this.#disposeBounds = this.windows.onWidgetBoundsChanged((bounds) =>
      this.acceptBounds(bounds),
    )
  }

  async stop(reason: 'auth-transition' | 'shutdown' = 'shutdown'): Promise<void> {
    ++this.#generation
    this.#disposeMonitor?.()
    this.#disposeMonitor = null
    this.#disposeBounds?.()
    this.#disposeBounds = null
    if (this.#boundsTimer !== null) {
      clearTimeout(this.#boundsTimer)
      this.#boundsTimer = null
      if (this.#userId !== null && this.#settings !== null) {
        await this.saveSettings(this.#userId, this.#settings)
      }
    }
    await this.#settingsMutation
    this.windows.close('widget', reason)
    this.#userId = null
    this.#settings = null
    this.#autoOpenedIds.clear()
    this.#autoOpenedOrder.length = 0
    this.#autoOpeningIds.clear()
  }

  getView(): WidgetView {
    const settings = this.requireSettings()
    return WidgetViewSchema.parse({
      settings,
      visible: this.windows.isWidgetVisible(),
      result: projectResult(this.monitor.getLatestResult()),
    })
  }

  getStatus(): WidgetStatus {
    const view = this.getView()
    return WidgetStatusSchema.parse({
      settings: view.settings,
      visible: view.visible,
      hasResult: view.result?.kind === 'player_found',
    })
  }

  async show(): Promise<WidgetStatus> {
    return this.open(false)
  }

  private async open(passive: boolean): Promise<WidgetStatus> {
    const settings = this.requireSettings()
    const generation = this.#generation
    await this.windows.ensureWidgetWindow(settings)
    if (generation !== this.#generation || this.#userId === null) {
      this.windows.close('widget', 'auth-transition')
      throw new ApplicationError('WIDGET_CANCELLED', 'Widget opening was cancelled')
    }
    this.windows.applyWidgetSettings(this.requireSettings())
    if (passive) this.windows.showWidgetInactive()
    else this.windows.showWidget()
    return this.getStatus()
  }

  async toggle(): Promise<WidgetStatus> {
    if (this.windows.isWidgetVisible()) this.windows.hideWidget()
    else await this.show()
    return this.getStatus()
  }

  hide(): WidgetStatus {
    this.requireSettings()
    this.windows.hideWidget()
    return this.getStatus()
  }

  async updateSettings(rawSettings: WidgetSettings): Promise<WidgetSettings> {
    const userId = this.requireUserId()
    const generation = this.#generation
    const settings = WidgetSettingsSchema.parse(rawSettings)
    const saved = await this.saveSettings(userId, settings)
    if (generation !== this.#generation || this.#userId !== userId) {
      throw new ApplicationError(
        'WIDGET_CANCELLED',
        'Widget settings update was cancelled',
      )
    }
    this.#settings = saved
    this.windows.applyWidgetSettings(this.#settings)
    return this.#settings
  }

  private acceptResult(result: MonitorResult): void {
    if (
      this.#settings?.autoOpen !== true ||
      result.kind !== 'player_found' ||
      this.#autoOpenedIds.has(result.id) ||
      this.#autoOpeningIds.has(result.id)
    ) {
      return
    }
    const generation = this.#generation
    this.#autoOpeningIds.add(result.id)
    void this.open(true)
      .then(() => this.rememberResult(result.id))
      .catch(() => undefined)
      .finally(() => {
        if (generation === this.#generation) this.#autoOpeningIds.delete(result.id)
      })
  }

  private acceptBounds(rawBounds: WidgetBounds): void {
    if (this.#settings === null || this.#userId === null) return
    const parsed = WidgetBoundsSchema.safeParse(rawBounds)
    if (!parsed.success) return
    const bounds = parsed.data
    this.#settings = { ...this.#settings, bounds }
    if (this.#boundsTimer !== null) clearTimeout(this.#boundsTimer)
    this.#boundsTimer = setTimeout(() => {
      this.#boundsTimer = null
      const userId = this.#userId
      const settings = this.#settings
      if (userId !== null && settings !== null) {
        void this.saveSettings(userId, settings).catch(() => undefined)
      }
    }, BOUNDS_SAVE_DELAY_MS)
  }

  private requireUserId(): string {
    if (this.#userId === null) {
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to use the local widget')
    }
    return this.#userId
  }

  private rememberResult(resultId: string): void {
    if (this.#autoOpenedIds.has(resultId)) return
    this.#autoOpenedIds.add(resultId)
    this.#autoOpenedOrder.push(resultId)
    while (this.#autoOpenedOrder.length > 100) {
      const oldest = this.#autoOpenedOrder.shift()
      if (oldest !== undefined) this.#autoOpenedIds.delete(oldest)
    }
  }

  private saveSettings(
    userId: string,
    settings: WidgetSettings,
  ): Promise<WidgetSettings> {
    const result = this.#settingsMutation.then(
      () => this.repository.save(userId, settings),
      () => this.repository.save(userId, settings),
    )
    this.#settingsMutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private requireSettings(): WidgetSettings {
    this.requireUserId()
    if (this.#settings === null) throw new Error('Widget settings are not loaded')
    return this.#settings
  }
}
