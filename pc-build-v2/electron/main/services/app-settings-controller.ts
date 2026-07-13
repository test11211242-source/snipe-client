import type { App } from 'electron'

import {
  AppSettingsUpdateSchema,
  AppSettingsViewSchema,
  type AppSettingsView,
} from '../../../shared/contracts/app'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import {
  createDefaultSettings,
  type Settings,
  type SettingsRepository,
} from '../infrastructure/settings-repository'

export class AppSettingsController {
  #settings: Settings = createDefaultSettings()
  #mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly repository: SettingsRepository,
    private readonly application: Pick<App, 'setLoginItemSettings'>,
    private readonly logger: StructuredLogger,
    private readonly platform: () => NodeJS.Platform = () => process.platform,
  ) {}

  async start(): Promise<AppSettingsView> {
    this.#settings = await this.repository.load()
    this.apply()
    return this.getView()
  }

  getView(): AppSettingsView {
    return AppSettingsViewSchema.parse({
      reducedMotion: this.#settings.appearance.reducedMotion,
      launchAtStartup: this.#settings.application.launchAtStartup,
      diagnosticsEnabled: this.#settings.application.diagnosticsEnabled,
    })
  }

  update(rawView: AppSettingsView): Promise<AppSettingsView> {
    const view = AppSettingsUpdateSchema.parse(rawView)
    const operation = this.#mutation.then(async () => {
      const next: Settings = {
        ...this.#settings,
        appearance: { ...this.#settings.appearance, reducedMotion: view.reducedMotion },
        application: {
          launchAtStartup: view.launchAtStartup,
          diagnosticsEnabled: view.diagnosticsEnabled,
        },
      }
      await this.repository.save(next)
      this.#settings = next
      this.apply()
    })
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation.then(() => this.getView())
  }

  private apply(): void {
    this.logger.setDiagnosticsEnabled(this.#settings.application.diagnosticsEnabled)
    if (this.platform() === 'win32') {
      this.application.setLoginItemSettings({
        openAtLogin: this.#settings.application.launchAtStartup,
      })
    }
  }
}
