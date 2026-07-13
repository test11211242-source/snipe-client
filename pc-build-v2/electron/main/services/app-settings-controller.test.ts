import { describe, expect, it, vi } from 'vitest'

import { createDefaultSettings } from '../infrastructure/settings-repository'
import { AppSettingsController } from './app-settings-controller'

describe('AppSettingsController', () => {
  it('exposes a strict token-free view and applies persisted Windows startup', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue({
        ...createDefaultSettings(),
        appearance: { theme: 'operational-dark', reducedMotion: true },
        application: { launchAtStartup: true, diagnosticsEnabled: false },
      }),
      save: vi.fn().mockImplementation((value) => Promise.resolve(value)),
    }
    const application = { setLoginItemSettings: vi.fn() }
    const logger = { setDiagnosticsEnabled: vi.fn() }
    const controller = new AppSettingsController(
      repository as never,
      application,
      logger as never,
      () => 'win32',
    )

    await expect(controller.start()).resolves.toEqual({
      reducedMotion: true,
      launchAtStartup: true,
      diagnosticsEnabled: false,
    })
    expect(application.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    expect(JSON.stringify(controller.getView())).not.toMatch(/token|secret/i)

    await expect(
      controller.update({
        reducedMotion: false,
        launchAtStartup: false,
        diagnosticsEnabled: true,
      }),
    ).resolves.toMatchObject({ diagnosticsEnabled: true })
    expect(application.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: false,
    })
    expect(logger.setDiagnosticsEnabled).toHaveBeenLastCalledWith(true)
  })

  it('rejects unknown renderer settings fields', () => {
    const controller = new AppSettingsController(
      { load: vi.fn(), save: vi.fn() } as never,
      { setLoginItemSettings: vi.fn() },
      { setDiagnosticsEnabled: vi.fn() } as never,
    )
    expect(() =>
      controller.update({
        reducedMotion: false,
        launchAtStartup: false,
        diagnosticsEnabled: false,
        token: 'not-allowed',
      } as never),
    ).toThrow()
  })
})
