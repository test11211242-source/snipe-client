import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StructuredLogger } from '../infrastructure/structured-logger'

const electronMocks = vi.hoisted(() => ({
  browserWindowConstructed: vi.fn<(options: unknown, instance: unknown) => void>(),
}))

vi.mock('electron', () => {
  class BrowserWindow {
    readonly webContents = {
      id: 7,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }

    constructor(options: unknown) {
      electronMocks.browserWindowConstructed(options, this)
    }

    isDestroyed(): boolean {
      return false
    }

    isMinimized(): boolean {
      return false
    }

    show = vi.fn()
    focus = vi.fn()
    once = vi.fn()
    on = vi.fn()
    loadFile = vi.fn().mockResolvedValue(undefined)
  }

  return { BrowserWindow }
})

import { WindowCoordinator } from './window-coordinator'

describe('WindowCoordinator auth shell', () => {
  beforeEach(() => {
    electronMocks.browserWindowConstructed.mockClear()
  })

  it('enforces isolated renderer preferences and blocks external navigation', async () => {
    const warn = vi.fn()
    const logger = { warn } as unknown as StructuredLogger
    const coordinator = new WindowCoordinator(logger)

    await coordinator.ensureAuthWindow()

    expect(electronMocks.browserWindowConstructed).toHaveBeenCalledOnce()
    const [options, rawWindow] =
      electronMocks.browserWindowConstructed.mock.calls[0] ?? []
    const browserOptions = options as {
      webPreferences: {
        contextIsolation: boolean
        nodeIntegration: boolean
        sandbox: boolean
        webSecurity: boolean
        preload: string
      }
    }
    expect(browserOptions.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    })
    expect(browserOptions.webPreferences.preload).toMatch(/preload[\\/]auth\.cjs$/)
    const window = rawWindow as {
      webContents: {
        on: ReturnType<typeof vi.fn>
        setWindowOpenHandler: ReturnType<typeof vi.fn>
      }
    }
    const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      (() => { action: string }) | undefined
    expect(openHandler?.()).toEqual({ action: 'deny' })

    const navigationRegistration = window.webContents.on.mock.calls.find(
      ([event]) => event === 'will-navigate',
    )
    const navigationHandler = navigationRegistration?.[1] as
      ((event: { preventDefault: () => void }, url: string) => void) | undefined
    const preventDefault = vi.fn()
    navigationHandler?.({ preventDefault }, 'https://example.com')
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('Blocked renderer navigation', {
      kind: 'auth',
      navigationUrl: 'https://example.com',
    })
  })
})
