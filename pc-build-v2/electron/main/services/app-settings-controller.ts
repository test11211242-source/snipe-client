import type { App } from 'electron'

import {
  AppSettingsUpdateSchema,
  AppSettingsViewSchema,
  type AppSettingsView,
  type AppSettingsUpdate,
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
      ...this.#settings.application,
    })
  }

  update(rawView: AppSettingsUpdate): Promise<AppSettingsView> {
    const view = AppSettingsUpdateSchema.parse(rawView)
    const operation = this.#mutation.then(async () => {
      const next: Settings = {
        ...this.#settings,
        appearance: {
          ...this.#settings.appearance,
          ...(view.reducedMotion === undefined
            ? {}
            : { reducedMotion: view.reducedMotion }),
        },
        application: {
          ...this.#settings.application,
          ...Object.fromEntries(
            Object.entries(view).filter(([key]) => key !== 'reducedMotion'),
          ),
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
        args: ['--launch-in-tray'],
      })
    }
  }
}
