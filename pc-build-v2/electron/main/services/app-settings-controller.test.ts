import { describe, expect, it, vi } from 'vitest'

import { createDefaultSettings } from '../infrastructure/settings-repository'
import { AppSettingsController } from './app-settings-controller'

describe('AppSettingsController', () => {
  it('exposes a strict token-free view and applies persisted Windows startup', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue({
        ...createDefaultSettings(),
        appearance: { theme: 'operational-dark', reducedMotion: true },
        application: { ...createDefaultSettings().application, launchAtStartup: true },
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
      autoStartMonitoring: true,
      closeToTray: true,
      notifyOpponentFound: true,
    })
    expect(application.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: ['--launch-in-tray'],
    })
    expect(JSON.stringify(controller.getView())).not.toMatch(/token|secret/i)

    await expect(
      controller.update({
        reducedMotion: false,
        launchAtStartup: false,
        diagnosticsEnabled: true,
        autoStartMonitoring: true,
        closeToTray: true,
        notifyOpponentFound: true,
      }),
    ).resolves.toMatchObject({ diagnosticsEnabled: true })
    expect(application.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: false,
      args: ['--launch-in-tray'],
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

describe('concurrent application setting patches', () => {
  it('serializes unrelated changes without overwriting the preceding patch', async () => {
    const gate = Promise.withResolvers<undefined>()
    const saved: unknown[] = []
    const repository = {
      load: vi.fn().mockResolvedValue(createDefaultSettings()),
      save: vi.fn((value: unknown) => {
        saved.push(value)
        return Promise.resolve()
      }),
    }
    const controller = new AppSettingsController(
      repository as never,
      { setLoginItemSettings: vi.fn() },
      { setDiagnosticsEnabled: vi.fn() } as never,
      () => 'win32',
    )
    await controller.start()
    repository.save.mockImplementationOnce(async (value: unknown) => {
      await gate.promise
      saved.push(value)
    })
    const close = controller.update({ closeToTray: false })
    const diagnostics = controller.update({ diagnosticsEnabled: true })
    await vi.waitFor(() => expect(repository.save).toHaveBeenCalledOnce())
    expect(repository.save).toHaveBeenCalledTimes(1)
    gate.resolve(undefined)
    await Promise.all([close, diagnostics])
    expect(controller.getView()).toMatchObject({
      closeToTray: false,
      diagnosticsEnabled: true,
    })
    expect(saved[1]).toMatchObject({
      application: { closeToTray: false, diagnosticsEnabled: true },
    })
  })

  it('continues queued patches after a failed save without applying the failed fields', async () => {
    const repository = {
      load: vi.fn().mockResolvedValue(createDefaultSettings()),
      save: vi
        .fn()
        .mockRejectedValueOnce(new Error('disk failed'))
        .mockResolvedValue(undefined),
    }
    const controller = new AppSettingsController(
      repository as never,
      { setLoginItemSettings: vi.fn() },
      { setDiagnosticsEnabled: vi.fn() } as never,
      () => 'win32',
    )
    await controller.start()
    await expect(controller.update({ autoStartMonitoring: false })).rejects.toThrow(
      'disk failed',
    )
    await controller.update({ notifyOpponentFound: false })
    expect(controller.getView()).toMatchObject({
      autoStartMonitoring: true,
      notifyOpponentFound: false,
    })
  })
})
