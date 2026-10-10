import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { CaptureProfileService } from './capture-profile-service'
import type { MonitorSupervisor } from './monitor-supervisor'
import type { WidgetController } from './widget-controller'
import type { CaptureProfilesView } from '../../../shared/models/capture'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { WidgetStatus } from '../../../shared/models/widget'

const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4nGNIvrSSgRKMS+I/DkzQAFwacRpEjmYUQ6hmAKma4YaMGkDFMBj4dMBAjaRMlcxEMgYAxzCBezbAVQ4AAAAASUVORK5CYII='

export class TrayController {
  #tray: Tray | null = null
  #dispose: (() => void) | null = null
  #profiles: CaptureProfilesView = { revision: null, activeProfileId: null, profiles: [] }
  #refreshGeneration = 0

  constructor(
    private readonly monitor: MonitorSupervisor,
    private readonly profiles: CaptureProfileService,
    private readonly widget: WidgetController,
    private readonly open: () => void,
    private readonly exit: () => Promise<void>,
    private readonly logger: StructuredLogger,
  ) {}

  start(): void {
    if (this.#tray !== null) return
    this.#tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON))
    this.#tray.setToolTip('CR Tools V2')
    this.#tray.on('double-click', this.open)
    this.#tray.on('right-click', () => {
      void this.refresh()
    })
    this.#dispose = this.monitor.subscribeViews(() => this.render())
    this.render()
  }

  async refresh(): Promise<void> {
    const generation = ++this.#refreshGeneration
    try {
      const profiles = await this.profiles.getView()
      if (generation !== this.#refreshGeneration || this.#tray === null) return
      this.#profiles = profiles
      this.render()
    } catch (error) {
      this.logger.warn('Tray profile refresh failed', { error })
    }
  }

  stop(): void {
    ++this.#refreshGeneration
    this.#dispose?.()
    this.#dispose = null
    this.#tray?.destroy()
    this.#tray = null
    this.#profiles = { revision: null, activeProfileId: null, profiles: [] }
  }

  private action(operation: () => Promise<unknown>): () => void {
    return () => {
      void operation()
        .then(() => this.refresh())
        .catch((error: unknown) => {
          this.logger.warn('Tray action failed', { error })
        })
    }
  }

  private render(): void {
    if (this.#tray === null) return
    const view = this.monitor.getCurrentView()
    const label =
      view.state === 'WAITING_SOURCE'
        ? 'Ждём окно игры…'
        : view.runIntent
          ? 'Мониторинг включён'
          : 'Мониторинг остановлен'
    let widgetStatus: WidgetStatus | null = null
    try {
      widgetStatus = this.widget.getStatus()
    } catch {
      /* Auth services are not ready. */
    }
    const menu: MenuItemConstructorOptions[] = [
      { label, enabled: false },
      { label: 'Открыть CR Tools', click: this.open },
      { type: 'separator' },
      {
        label: view.runIntent ? 'Остановить мониторинг' : 'Начать мониторинг',
        enabled:
          view.runIntent ||
          (view.readiness.authenticated && this.#profiles.profiles.length > 0),
        click: this.action(() =>
          view.runIntent ? this.monitor.stop() : this.monitor.start(),
        ),
      },
      {
        label: 'Профиль',
        enabled: this.#profiles.profiles.length > 0,
        submenu: this.#profiles.profiles.map((profile) => ({
          label: profile.profileName,
          type: 'radio',
          checked: profile.isActive,
          click: this.action(async () => {
            const current = await this.profiles.getView()
            if (current.revision === null) return
            await this.profiles.activate(profile.profileId, current.revision)
          }),
        })),
      },
      {
        label: widgetStatus?.visible ? 'Скрыть оверлей' : 'Показать оверлей',
        enabled: widgetStatus !== null,
        click: this.action(() => this.widget.toggle()),
      },
      {
        label: 'Заблокировать оверлей',
        type: 'checkbox',
        enabled: widgetStatus !== null,
        checked: widgetStatus?.settings.locked ?? false,
        click: this.action(async () => {
          await this.widget.updateSettings({
            locked: !this.widget.getStatus().settings.locked,
          })
        }),
      },
      { type: 'separator' },
      { label: 'Выход', click: this.action(this.exit) },
    ]
    this.#tray.setToolTip(`CR Tools V2 — ${label}`)
    this.#tray.setContextMenu(Menu.buildFromTemplate(menu))
  }
}
