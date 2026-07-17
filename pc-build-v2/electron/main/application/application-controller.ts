import { session, type App } from 'electron'

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
import type { WindowCoordinator } from '../windows/window-coordinator'
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
      setup: this.setup,
    })
    const disposeMonitorIpc = registerMonitorIpc({
      windows: this.windows,
      logger: this.logger,
      monitor: this.monitor,
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
    await this.windows.ensureAuthWindow()
    this.logger.info('Authentication shell ready', this.getSnapshot())
    const initialView = await this.auth.bootstrap()
    if (this.lifecycle.state === 'SHUTTING_DOWN' || this.lifecycle.state === 'STOPPED') {
      return
    }
    await this.syncWindows(initialView)
    this.#disposeAuthSubscription = this.auth.subscribe((view) =>
      this.queueWindowSync(view),
    )
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
      if (this.auth.getView().state === 'AUTHENTICATED') {
        void this.windows.ensureMainWindow()
      } else {
        void this.windows.ensureAuthWindow()
      }
    })
    this.electronApp.on('window-all-closed', () => {
      if (this.lifecycle.state === 'READY') void this.requestShutdown()
    })
    this.electronApp.on('before-quit', (event) => {
      if (this.lifecycle.state !== 'STOPPED') {
        event.preventDefault()
        void this.requestShutdown()
      }
    })
  }

  private queueWindowSync(view: AuthView): void {
    this.#windowSync = this.#windowSync
      .then(() => this.syncWindows(view))
      .catch((error: unknown) =>
        this.logger.error('Window auth transition failed', { error }),
      )
  }

  private async syncWindows(view: AuthView): Promise<void> {
    if (view.state === 'AUTHENTICATED') {
      if (view.user === null) throw new Error('Authenticated view is missing its user')
      if (this.#activeUserId !== view.user.id) {
        if (this.#activeUserId !== null) {
          await this.capturePreparations.stop()
          this.realtime.stop()
          this.reprocessedResults.stop()
          this.notifications.stop()
          await this.streamer.stop()
          await this.widget.stop('auth-transition')
        }
        this.images.stop()
        await this.monitor.stop()
        this.monitor.setUserContext(view.user.id)
        this.#activeUserId = view.user.id
      }
      if (
        this.lifecycle.state === 'AUTHENTICATING' ||
        this.lifecycle.state === 'RECOVERING'
      ) {
        this.lifecycle.transitionTo('READY')
      }
      await this.windows.ensureMainWindow()
      await this.widget.start(view.user.id)
      this.notifications.start()
      this.reprocessedResults.start(view.user.id)
      this.streamer.start()
      this.windows.close('auth', 'auth-transition')
      this.realtime.start()
      return
    }

    this.realtime.stop()
    await this.capturePreparations.stop()
    this.reprocessedResults.stop()
    this.notifications.stop()
    this.images.stop()
    await this.streamer.stop()
    await this.widget.stop('auth-transition')
    await this.monitor.stop()
    this.monitor.setUserContext(null)
    this.#activeUserId = null
    this.windows.close('setup', 'auth-transition')
    try {
      const setup = this.setup.getSession()
      this.setup.cancel(setup.sessionId, setup.generation)
    } catch {
      // No active setup.
    }
    if (this.lifecycle.state === 'READY') this.lifecycle.transitionTo('RECOVERING')
    await this.windows.ensureAuthWindow()
    this.windows.close('main', 'auth-transition')
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
    await this.monitor.stop()
    await this.capturePreparations.stop()
    try {
      const setup = this.setup.getSession()
      this.setup.cancel(setup.sessionId, setup.generation)
    } catch {
      // No cancellable setup remains.
    }
    this.windows.closeAll('shutdown')
    this.lifecycle.transitionTo('STOPPED')
    this.logger.info('Application stopped cleanly')
    this.electronApp.quit()
    await Promise.resolve()
  }
}
