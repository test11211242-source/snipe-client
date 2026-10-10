import { dialog, session, type App } from 'electron'

import type { AppSnapshot } from '../../../shared/models/application'
import type { AuthView } from '../../../shared/models/auth'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import { SETTINGS_VERSION } from '../infrastructure/settings-repository'
import { registerAppIpc } from '../ipc/register-app-ipc'
import { registerAuthNetworkIpc } from '../ipc/register-auth-network-ipc'
import { registerCaptureIpc } from '../ipc/register-capture-ipc'
import { registerMonitorIpc } from '../ipc/register-monitor-ipc'
import { registerWidgetIpc } from '../ipc/register-widget-ipc'
import { registerStreamerIpc } from '../ipc/register-streamer-ipc'
import { registerUpdateIpc } from '../ipc/register-update-ipc'
import type { AuthSession } from '../services/auth-session'
import type { CaptureSourceRegistry } from '../services/capture-source-registry'
import type { SetupSessionService } from '../services/setup-session-service'
import type { MonitorSupervisor } from '../services/monitor-supervisor'
import type { ImageAssetService } from '../services/image-asset-service'
import type { WidgetController } from '../services/widget-controller'
import type { WebSocketSession } from '../services/websocket-session'
import type { StreamerService } from '../services/streamer-service'
import type { UpdateService } from '../services/update-service'
import type { AppSettingsController } from '../services/app-settings-controller'
import type { NotificationService } from '../services/notification-service'
import type { ReprocessedResultService } from '../services/reprocessed-result-service'
import type { CapturePreparationService } from '../services/capture-preparation-service'
import type { CaptureProfileService } from '../services/capture-profile-service'
import type { WindowCoordinator } from '../windows/window-coordinator'
import type { TrayController } from '../services/tray-controller'
import { ApplicationLifecycle } from './lifecycle'
import { installDenyAllSessionPermissions } from '../services/session-permissions'

export class ApplicationController {
  readonly lifecycle = new ApplicationLifecycle()
  #disposeIpc: (() => void) | undefined
  #disposeAuthSubscription: (() => void) | undefined
  #disposeWindowSubscription: (() => void) | undefined
  #shutdownPromise: Promise<void> | undefined
  #windowSync: Promise<void> = Promise.resolve()
  #activeUserId: string | null = null
  #authGeneration = 0
  #requestedUserId: string | null | undefined
  readonly #autoStartedUsers = new Set<string>()
  readonly #launchInTray = process.argv.includes('--launch-in-tray')

  constructor(
    private readonly electronApp: App,
    private readonly windows: WindowCoordinator,
    private readonly settings: AppSettingsController,
    private readonly logger: StructuredLogger,
    private readonly auth: AuthSession,
    private readonly realtime: WebSocketSession,
    private readonly captureSources: CaptureSourceRegistry,
    private readonly setup: SetupSessionService,
    private readonly monitor: MonitorSupervisor,
    private readonly widget: WidgetController,
    private readonly images: ImageAssetService,
    private readonly notifications: NotificationService,
    private readonly reprocessedResults: ReprocessedResultService,
    private readonly streamer: StreamerService,
    private readonly updater: UpdateService,
    private readonly capturePreparations: CapturePreparationService,
    private readonly captureProfiles: CaptureProfileService,
    private readonly tray?: TrayController,
  ) {}

  async start(): Promise<void> {
    if (!this.electronApp.requestSingleInstanceLock()) {
      this.lifecycle.transitionTo('SHUTTING_DOWN')
      this.lifecycle.transitionTo('STOPPED')
      this.electronApp.quit()
      return
    }

    this.bindApplicationEvents()
    await this.electronApp.whenReady()
    installDenyAllSessionPermissions(session.defaultSession)
    this.electronApp.setAppUserModelId('com.snipe.client.v2')
    this.updater.start()

    await this.settings.start()
    this.tray?.start()
    this.windows.setUserClosePolicy(
      (kind) =>
        this.tray !== undefined &&
        (kind === 'main' || kind === 'auth') &&
        this.settings.getView().closeToTray &&
        this.lifecycle.state !== 'SHUTTING_DOWN' &&
        this.lifecycle.state !== 'STOPPED',
    )
    this.windows.setSessionEndHandler(() => {
      void this.requestShutdown()
    })
    this.lifecycle.transitionTo('AUTHENTICATING')

    const disposeAppIpc = registerAppIpc({
      windows: this.windows,
      logger: this.logger,
      getSnapshot: () => this.getSnapshot(),
      settings: this.settings,
    })
    const disposeAuthIpc = registerAuthNetworkIpc({
      windows: this.windows,
      logger: this.logger,
      auth: this.auth,
      realtime: this.realtime,
    })
    const disposeCaptureIpc = registerCaptureIpc({
      windows: this.windows,
      logger: this.logger,
      registry: this.captureSources,
      preparations: this.capturePreparations,
      profiles: this.captureProfiles,
      setup: this.setup,
    })
    const disposeMonitorIpc = registerMonitorIpc({
      windows: this.windows,
      logger: this.logger,
      monitor: this.monitor,
      widget: this.widget,
    })
    const disposeWidgetIpc = registerWidgetIpc({
      windows: this.windows,
      logger: this.logger,
      widget: this.widget,
      images: this.images,
    })
    const disposeStreamerIpc = registerStreamerIpc({
      windows: this.windows,
      logger: this.logger,
      streamer: this.streamer,
      setup: this.setup,
    })
    const disposeUpdateIpc = registerUpdateIpc({
      windows: this.windows,
      logger: this.logger,
      updater: this.updater,
    })
    this.#disposeIpc = () => {
      disposeAppIpc()
      disposeAuthIpc()
      disposeCaptureIpc()
      disposeMonitorIpc()
      disposeWidgetIpc()
      disposeStreamerIpc()
      disposeUpdateIpc()
    }

    this.logger.info('Opening authentication shell', this.getSnapshot())
    await this.windows.ensureAuthWindow(!this.#launchInTray)
    this.logger.info('Authentication shell ready', this.getSnapshot())
    this.#disposeAuthSubscription = this.auth.subscribe((view) =>
      this.queueWindowSync(view),
    )
    const generation = this.#authGeneration
    const initialView = await this.auth.bootstrap()
    if (this.lifecycle.state === 'SHUTTING_DOWN' || this.lifecycle.state === 'STOPPED') {
      return
    }
    if (generation === this.#authGeneration) this.queueWindowSync(initialView)
    await this.#windowSync
    this.logger.info('Application auth and network core ready', this.getSnapshot())
  }

  requestShutdown(): Promise<void> {
    this.#shutdownPromise ??= this.shutdown()
    return this.#shutdownPromise
  }

  private bindApplicationEvents(): void {
    this.#disposeWindowSubscription = this.windows.onWindowClosed((kind, reason) => {
      if (reason !== 'user') return
      if (kind === 'setup') {
        try {
          const view = this.setup.getSession()
          this.setup.cancel(view.sessionId, view.generation)
        } catch {
          // A terminal setup needs no cancellation.
        }
      } else if (kind !== 'widget') {
        void this.requestShutdown()
      }
    })
    this.electronApp.on('second-instance', () => this.windows.focusActiveWindow())
    this.electronApp.on('activate', () => {
      if (this.lifecycle.state === 'READY') {
        this.queueWindowSync(this.auth.getView(), true)
      } else {
        void this.windows.ensureAuthWindow()
      }
    })
    this.electronApp.on('window-all-closed', () => {
      if (this.tray === undefined || !this.settings.getView().closeToTray) {
        void this.requestShutdown()
      }
    })
    this.electronApp.on('before-quit', (event) => {
      if (this.lifecycle.state !== 'STOPPED') {
        event.preventDefault()
        void this.requestShutdown()
      }
    })
  }

  private queueWindowSync(view: AuthView, force = false): void {
    const requestedUserId = view.state === 'AUTHENTICATED' ? view.user?.id : null
    if (!force && requestedUserId != null && requestedUserId === this.#requestedUserId)
      return
    this.#requestedUserId = requestedUserId
    const generation = ++this.#authGeneration
    this.#windowSync = this.#windowSync
      .then(async () => {
        if (generation === this.#authGeneration) await this.syncWindows(view)
      })
      .catch((error: unknown) => {
        if (generation === this.#authGeneration) this.#requestedUserId = undefined
        this.logger.error('Window auth transition failed', { error })
      })
  }

  private async syncWindows(view: AuthView): Promise<void> {
    if (view.state === 'AUTHENTICATED') {
      if (view.user === null) throw new Error('Authenticated view is missing its user')
      const generation = this.#authGeneration
      if (this.#activeUserId !== view.user.id) {
        this.setup.cancelForAuthTransition()
        if (this.#activeUserId !== null) {
          await this.capturePreparations.stop()
          this.realtime.stop()
          this.reprocessedResults.stop()
          this.notifications.stop()
          await this.streamer.stop()
          await this.widget.stop('auth-transition')
        }
        this.images.stop()
        await this.monitor.stop('auth_change')
        this.monitor.setUserContext(view.user.id)
        this.#activeUserId = view.user.id
      }
      for (;;) {
        try {
          await this.widget.start(view.user.id)
          break
        } catch (error) {
          this.logger.error('Authenticated services initialization failed', {
            stage: 'widget-settings',
            error,
          })
          if (generation !== this.#authGeneration) return
          const choice = await dialog.showMessageBox({
            type: 'error',
            title: 'Не удалось открыть CR Tools',
            message:
              'Не удалось загрузить настройки виджета. Основное окно ещё не готово.',
            buttons: ['Повторить', 'Выйти из профиля'],
            defaultId: 0,
            cancelId: 1,
          })
          if (generation !== this.#authGeneration) return
          if (choice.response !== 0) {
            await this.auth.logout()
            return
          }
        }
      }
      if (
        generation !== this.#authGeneration ||
        this.lifecycle.state === 'SHUTTING_DOWN' ||
        this.lifecycle.state === 'STOPPED'
      ) {
        await this.widget.stop('auth-transition')
        return
      }
      if (
        this.lifecycle.state === 'AUTHENTICATING' ||
        this.lifecycle.state === 'RECOVERING'
      ) {
        this.lifecycle.transitionTo('READY')
      }
      await this.windows.ensureMainWindow(!this.#launchInTray)
      void this.images.start().catch((error: unknown) => {
        this.logger.warn('Card image cache warmup failed', { error })
      })
      this.notifications.start()
      this.reprocessedResults.start(view.user.id)
      this.streamer.start()
      this.windows.close('auth', 'auth-transition')
      this.realtime.start()
      void this.tray?.refresh()
      if (!this.#autoStartedUsers.has(view.user.id)) {
        this.#autoStartedUsers.add(view.user.id)
        if (this.settings.getView().autoStartMonitoring) {
          const monitorView = await this.monitor.getView()
          if (generation !== this.#authGeneration) return
          if (monitorView.readiness.captureConfigured) await this.monitor.start()
        }
      }
      return
    }

    this.realtime.stop()
    await this.capturePreparations.stop()
    this.reprocessedResults.stop()
    this.notifications.stop()
    this.images.stop()
    await this.streamer.stop()
    await this.widget.stop('auth-transition')
    await this.monitor.stop('auth_change')
    this.monitor.setUserContext(null)
    this.#activeUserId = null
    this.windows.close('setup', 'auth-transition')
    this.setup.cancelForAuthTransition()
    if (this.lifecycle.state === 'READY') this.lifecycle.transitionTo('RECOVERING')
    await this.windows.ensureAuthWindow(!this.#launchInTray)
    this.windows.close('main', 'auth-transition')
    void this.tray?.refresh()
  }

  private getSnapshot(): AppSnapshot {
    return {
      lifecycle: this.lifecycle.state,
      version: this.electronApp.getVersion(),
      settingsVersion: SETTINGS_VERSION,
    }
  }

  private async shutdown(): Promise<void> {
    if (this.lifecycle.state === 'STOPPED') return
    if (this.lifecycle.state !== 'SHUTTING_DOWN') {
      this.lifecycle.transitionTo('SHUTTING_DOWN')
    }

    this.auth.cancelPendingOperations()
    ++this.#authGeneration
    this.tray?.stop()
    await this.updater.stop()
    this.#disposeIpc?.()
    this.#disposeIpc = undefined
    this.#disposeAuthSubscription?.()
    this.#disposeAuthSubscription = undefined
    this.#disposeWindowSubscription?.()
    this.#disposeWindowSubscription = undefined
    this.realtime.stop()
    this.reprocessedResults.stop()
    this.notifications.stop()
    this.images.stop()
    await this.streamer.stop()
    await this.widget.stop('shutdown')
    await this.monitor.stop('exit')
    await this.capturePreparations.stop()
    this.setup.cancelForAuthTransition()
    await this.windows.flushMainState()
    this.windows.closeAll('shutdown')
    this.lifecycle.transitionTo('STOPPED')
    this.logger.info('Application stopped cleanly')
    await this.logger.flush()
    this.electronApp.quit()
    await Promise.resolve()
  }
}
