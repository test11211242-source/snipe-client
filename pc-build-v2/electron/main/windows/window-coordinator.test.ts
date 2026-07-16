import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StructuredLogger } from '../infrastructure/structured-logger'

const electronMocks = vi.hoisted(() => ({
  browserWindowConstructed: vi.fn<(options: unknown, instance: unknown) => void>(),
  loadFile: vi.fn<(path: string) => Promise<void>>(),
}))

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false
    readonly webContents = {
      id: 7,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }

    constructor(options: unknown) {
      electronMocks.browserWindowConstructed(options, this)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isMinimized(): boolean {
      return false
    }

    show = vi.fn()
    focus = vi.fn()
    once = vi.fn()
    on = vi.fn()
    loadFile = vi.fn((path: string) => electronMocks.loadFile(path))
    loadURL = vi.fn().mockResolvedValue(undefined)
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 420, height: 560 }))
  }

  return {
    BrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    },
  }
})

import {
  clampWidgetBoundsToWorkAreas,
  fitWindowBounds,
  isAllowedRendererUrl,
  persistableWidgetBounds,
  resolveDevelopmentRendererUrl,
  WindowCoordinator,
} from './window-coordinator'

describe('WindowCoordinator auth shell', () => {
  beforeEach(() => {
    electronMocks.browserWindowConstructed.mockClear()
    electronMocks.loadFile.mockReset().mockResolvedValue(undefined)
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
  })

  afterEach(() => vi.unstubAllEnvs())

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
    expect(
      (rawWindow as { loadURL: ReturnType<typeof vi.fn> }).loadURL,
    ).not.toHaveBeenCalled()
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

  it('allows only credential-free loopback dev URLs and ignores them in production', () => {
    expect(
      resolveDevelopmentRendererUrl('http://127.0.0.1:5173', 'auth.html', false),
    ).toBe('http://127.0.0.1:5173/auth.html')
    expect(
      resolveDevelopmentRendererUrl('https://[::1]:5173/', 'setup.html', false),
    ).toBe('https://[::1]:5173/setup.html')
    expect(
      resolveDevelopmentRendererUrl('http://user@localhost:5173', 'index.html', false),
    ).toBeNull()
    expect(
      resolveDevelopmentRendererUrl('https://example.com', 'index.html', false),
    ).toBeNull()
    expect(
      resolveDevelopmentRendererUrl('http://localhost:5173', 'index.html', true),
    ).toBeNull()
  })

  it('fits normal windows and clamps saved widget bounds to current work areas', () => {
    expect(
      fitWindowBounds(
        { x: -100, y: 20, width: 640, height: 480 },
        { width: 1280, height: 860 },
        { width: 860, height: 640 },
      ),
    ).toEqual({
      x: -100,
      y: 20,
      width: 640,
      height: 480,
      minWidth: 640,
      minHeight: 480,
    })
    const workAreas = [
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 800, y: 0, width: 1024, height: 768 },
    ]
    expect(
      clampWidgetBoundsToWorkAreas(
        { x: 1600, y: 700, width: 420, height: 560 },
        workAreas,
      ),
    ).toEqual({ x: 1404, y: 208, width: 420, height: 560 })
    expect(
      clampWidgetBoundsToWorkAreas(
        { x: 5000, y: 5000, width: 720, height: 900 },
        workAreas,
      ),
    ).toEqual({ x: 80, y: 0, width: 720, height: 600 })
    expect(
      persistableWidgetBounds({ x: -50_000, y: 50_000, width: 200, height: 120 }),
    ).toEqual({ x: -32_768, y: 32_767, width: 340, height: 300 })
  })

  it('coalesces widget loading, destroys failed loads, and allows retry', async () => {
    let release!: () => void
    electronMocks.loadFile.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const warn = vi.fn()
    const coordinator = new WindowCoordinator({ warn } as never)
    const settings = {
      autoOpen: true,
      alwaysOnTop: true,
      locked: false,
      opacity: 1,
      compactMode: false,
      bounds: { x: null, y: null, width: 420, height: 560 },
    }
    const first = coordinator.ensureWidgetWindow(settings)
    const second = coordinator.ensureWidgetWindow(settings)
    expect(electronMocks.browserWindowConstructed).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(electronMocks.loadFile).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    const loadedWindow = electronMocks.browserWindowConstructed.mock.calls[0]?.[1] as {
      on: ReturnType<typeof vi.fn>
      getBounds: ReturnType<typeof vi.fn>
    }
    const observed = vi.fn()
    coordinator.onWidgetBoundsChanged(observed)
    coordinator.onWidgetBoundsChanged(() => {
      throw new Error('listener failed')
    })
    loadedWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 200, height: 120 })
    const move = loadedWindow.on.mock.calls.find(([event]) => event === 'move')?.[1] as
      (() => void) | undefined
    expect(() => move?.()).not.toThrow()
    expect(observed).toHaveBeenCalledWith({ x: 0, y: 0, width: 340, height: 300 })
    const warning = warn.mock.calls[0] as unknown as
      [string, { error: unknown }] | undefined
    expect(warning?.[0]).toBe('Widget bounds listener failed')
    expect(warning?.[1].error).toBeInstanceOf(Error)

    electronMocks.loadFile.mockRejectedValueOnce(new Error('load failed'))
    coordinator.close('widget', 'auth-transition')
    const failed = coordinator.ensureWidgetWindow(settings)
    const failedWindow = electronMocks.browserWindowConstructed.mock.calls.at(
      -1,
    )?.[1] as {
      destroy: ReturnType<typeof vi.fn>
    }
    await expect(failed).rejects.toThrow('load failed')
    expect(failedWindow.destroy).toHaveBeenCalledOnce()

    await expect(coordinator.ensureWidgetWindow(settings)).resolves.toBeUndefined()
    expect(electronMocks.browserWindowConstructed).toHaveBeenCalledTimes(3)
  })

  it('normalizes encoded Windows file URLs without allowing a different renderer', () => {
    const expected =
      'file:///C:/Users/Operator/AppData/Local/Programs/CR%20Tools%20V2/resources/app.asar/out/renderer/auth.html'
    expect(
      isAllowedRendererUrl(
        'file:///c:/users/operator/appdata/local/programs/CR%20Tools%20V2/resources/app.asar/out/renderer/auth.html',
        expected,
        'win32',
      ),
    ).toBe(true)
    expect(
      isAllowedRendererUrl(
        'file:///C:/Users/Operator/AppData/Local/Programs/CR%20Tools%20V2/resources/app.asar/out/renderer/index.html',
        expected,
        'win32',
      ),
    ).toBe(false)
  })
})
