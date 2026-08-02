import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'

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
      send: vi.fn(),
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
    hide = vi.fn()
    focus = vi.fn()
    showInactive = vi.fn()
    once = vi.fn()
    on = vi.fn()
    loadFile = vi.fn((path: string) => electronMocks.loadFile(path))
    loadURL = vi.fn().mockResolvedValue(undefined)
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 420, height: 360 }))
    isAlwaysOnTop = vi.fn(() => true)
    moveTop = vi.fn()
    setAlwaysOnTop = vi.fn()
    setAspectRatio = vi.fn()
    setMinimumSize = vi.fn()
    setMovable = vi.fn()
    setResizable = vi.fn()
    setOpacity = vi.fn()
    setBounds = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    isVisible = vi.fn(() => false)
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
  WIDGET_RENDERER_READY_TIMEOUT_MS,
} from './window-coordinator'

describe('WindowCoordinator auth shell', () => {
  beforeEach(() => {
    electronMocks.browserWindowConstructed.mockClear()
    electronMocks.loadFile.mockReset().mockResolvedValue(undefined)
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
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

  it('accepts a registered auth sender when auth is one of the allowed kinds', async () => {
    const warn = vi.fn()
    const coordinator = new WindowCoordinator({ warn } as unknown as StructuredLogger)
    const authWindow = await coordinator.ensureAuthWindow()
    const loadedPath = electronMocks.loadFile.mock.calls[0]?.[0]
    if (loadedPath === undefined) throw new Error('Auth renderer path was not loaded')

    expect(() =>
      coordinator.assertSender(authWindow.webContents, pathToFileURL(loadedPath).href, [
        'main',
        'auth',
      ]),
    ).not.toThrow()
    expect(() =>
      coordinator.assertSender(
        authWindow.webContents,
        'https://attacker.example/auth.html',
        ['main', 'auth'],
      ),
    ).toThrow('IPC sender is not authorized')
    expect(warn).toHaveBeenCalledOnce()
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
    ).toEqual({ x: -32_768, y: 32_767, width: 300, height: 280 })
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
      displayMode: 'detailed' as const,
      bounds: { x: null, y: null, width: 420, height: 360 },
    }
    const first = coordinator.ensureWidgetWindow(settings)
    const second = coordinator.ensureWidgetWindow(settings)
    expect(electronMocks.browserWindowConstructed).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(electronMocks.loadFile).toHaveBeenCalledTimes(1)
    const loadedWindow = electronMocks.browserWindowConstructed.mock.calls[0]?.[1] as {
      getBounds: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      setAspectRatio: ReturnType<typeof vi.fn>
      setIgnoreMouseEvents: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
    }
    coordinator.showWidget()
    expect(loadedWindow.show).not.toHaveBeenCalled()
    release()
    coordinator.markWidgetRendererReady()
    await Promise.all([first, second])
    coordinator.showWidget()
    expect(loadedWindow.show).toHaveBeenCalledOnce()
    expect(loadedWindow.setIgnoreMouseEvents).toHaveBeenNthCalledWith(1, true)
    expect(loadedWindow.setIgnoreMouseEvents).toHaveBeenNthCalledWith(2, false)
    const widgetOptions = electronMocks.browserWindowConstructed.mock.calls[0]?.[0] as {
      frame: boolean
      transparent: boolean
      minimizable: boolean
      maximizable: boolean
    }
    expect(widgetOptions).toMatchObject({
      frame: false,
      transparent: true,
      minimizable: false,
      maximizable: false,
    })
    expect(loadedWindow.setAspectRatio).toHaveBeenCalledWith(0)
    const observed = vi.fn()
    coordinator.onWidgetBoundsChanged(observed)
    coordinator.onWidgetBoundsChanged(() => {
      throw new Error('listener failed')
    })
    loadedWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 200, height: 120 })
    const move = loadedWindow.on.mock.calls.find(([event]) => event === 'move')?.[1] as
      (() => void) | undefined
    expect(() => move?.()).not.toThrow()
    expect(observed).toHaveBeenCalledWith({ x: 0, y: 0, width: 300, height: 280 })
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

    const retry = coordinator.ensureWidgetWindow(settings)
    coordinator.markWidgetRendererReady()
    await expect(retry).resolves.toBeUndefined()
    expect(electronMocks.browserWindowConstructed).toHaveBeenCalledTimes(3)
  })

  it('keeps the frameless overlay freely resizable and topmost on blur', async () => {
    const coordinator = new WindowCoordinator({ warn: vi.fn() } as never)
    const settings = {
      autoOpen: true,
      alwaysOnTop: true,
      locked: false,
      opacity: 0.96,
      displayMode: 'deck' as const,
      bounds: { x: null, y: null, width: 360, height: 300 },
    }

    const opening = coordinator.ensureWidgetWindow(settings)
    coordinator.markWidgetRendererReady()
    await opening
    coordinator.applyWidgetSettings(settings)
    coordinator.showWidgetInactive()

    const [options, rawWindow] =
      electronMocks.browserWindowConstructed.mock.calls[0] ?? []
    expect(options).toMatchObject({
      frame: false,
      transparent: true,
      minWidth: 300,
      minHeight: 280,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
    })
    const window = rawWindow as {
      on: ReturnType<typeof vi.fn>
      moveTop: ReturnType<typeof vi.fn>
      setAlwaysOnTop: ReturnType<typeof vi.fn>
      setAspectRatio: ReturnType<typeof vi.fn>
      setMinimumSize: ReturnType<typeof vi.fn>
      showInactive: ReturnType<typeof vi.fn>
    }
    expect(window.setMinimumSize).toHaveBeenCalledWith(300, 280)
    expect(window.setAspectRatio).toHaveBeenLastCalledWith(0)
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'normal')
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.moveTop).toHaveBeenCalled()

    const blur = window.on.mock.calls.find(([event]) => event === 'blur')?.[1] as
      (() => void) | undefined
    const moveCount = window.moveTop.mock.calls.length
    blur?.()
    expect(window.moveTop).toHaveBeenCalledTimes(moveCount + 1)
  })

  it('destroys a non-interactive widget when renderer readiness times out', async () => {
    vi.useFakeTimers()
    const coordinator = new WindowCoordinator({ warn: vi.fn() } as never)
    const settings = {
      autoOpen: true,
      alwaysOnTop: true,
      locked: false,
      opacity: 1,
      displayMode: 'detailed' as const,
      bounds: { x: null, y: null, width: 420, height: 360 },
    }

    const opening = coordinator.ensureWidgetWindow(settings)
    const rejection = expect(opening).rejects.toMatchObject({
      code: 'WIDGET_RENDERER_TIMEOUT',
    })
    const window = electronMocks.browserWindowConstructed.mock.calls[0]?.[1] as {
      destroy: ReturnType<typeof vi.fn>
      hide: ReturnType<typeof vi.fn>
      setIgnoreMouseEvents: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
    }
    coordinator.showWidget()
    expect(window.show).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(WIDGET_RENDERER_READY_TIMEOUT_MS)

    await rejection
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('suppresses input again until a reloaded widget renderer is ready', async () => {
    const coordinator = new WindowCoordinator({ warn: vi.fn() } as never)
    const settings = {
      autoOpen: true,
      alwaysOnTop: true,
      locked: false,
      opacity: 1,
      displayMode: 'detailed' as const,
      bounds: { x: null, y: null, width: 420, height: 360 },
    }
    const opening = coordinator.ensureWidgetWindow(settings)
    coordinator.markWidgetRendererReady()
    await opening
    const window = electronMocks.browserWindowConstructed.mock.calls[0]?.[1] as {
      setIgnoreMouseEvents: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
      webContents: { on: ReturnType<typeof vi.fn> }
    }
    const navigation = window.webContents.on.mock.calls.find(
      ([event]) => event === 'did-start-navigation',
    )?.[1] as
      | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
      | undefined

    const loadedPath = electronMocks.loadFile.mock.calls[0]?.[0]
    if (loadedPath === undefined) throw new Error('Widget renderer path was not loaded')
    navigation?.({}, pathToFileURL(loadedPath).href, false, true)
    coordinator.showWidget()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true)

    coordinator.markWidgetRendererReady()
    coordinator.showWidget()
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('ignores in-place navigation and supersedes overlapping reload readiness', async () => {
    vi.useFakeTimers()
    const coordinator = new WindowCoordinator({ warn: vi.fn() } as never)
    const settings = {
      autoOpen: true,
      alwaysOnTop: true,
      locked: false,
      opacity: 1,
      displayMode: 'detailed' as const,
      bounds: { x: null, y: null, width: 420, height: 360 },
    }
    const opening = coordinator.ensureWidgetWindow(settings)
    coordinator.markWidgetRendererReady()
    await opening
    const window = electronMocks.browserWindowConstructed.mock.calls[0]?.[1] as {
      destroy: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
      webContents: { on: ReturnType<typeof vi.fn> }
    }
    const navigation = window.webContents.on.mock.calls.find(
      ([event]) => event === 'did-start-navigation',
    )?.[1] as
      | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
      | undefined
    const loadedPath = electronMocks.loadFile.mock.calls[0]?.[0]
    if (loadedPath === undefined) throw new Error('Widget renderer path was not loaded')
    const rendererUrl = pathToFileURL(loadedPath).href

    navigation?.({}, `${rendererUrl}#deck`, true, true)
    coordinator.showWidget()
    expect(window.show).toHaveBeenCalledOnce()
    window.show.mockClear()

    navigation?.({}, rendererUrl, false, true)
    await vi.advanceTimersByTimeAsync(5_000)
    navigation?.({}, rendererUrl, false, true)
    await vi.advanceTimersByTimeAsync(5_100)
    expect(window.destroy).not.toHaveBeenCalled()
    coordinator.markWidgetRendererReady()
    coordinator.showWidget()
    expect(window.show).toHaveBeenCalledOnce()
  })

  it.each(['did-fail-load', 'render-process-gone', 'unresponsive'] as const)(
    'destroys the widget after %s',
    async (failure) => {
      const coordinator = new WindowCoordinator({ warn: vi.fn() } as never)
      const settings = {
        autoOpen: true,
        alwaysOnTop: true,
        locked: false,
        opacity: 1,
        displayMode: 'detailed' as const,
        bounds: { x: null, y: null, width: 420, height: 360 },
      }
      const opening = coordinator.ensureWidgetWindow(settings)
      const window = electronMocks.browserWindowConstructed.mock.calls[0]?.[1] as {
        destroy: ReturnType<typeof vi.fn>
        hide: ReturnType<typeof vi.fn>
        on: ReturnType<typeof vi.fn>
        webContents: { on: ReturnType<typeof vi.fn> }
      }
      const rejection = expect(opening).rejects.toMatchObject({
        code:
          failure === 'did-fail-load'
            ? 'WIDGET_LOAD_FAILED'
            : failure === 'render-process-gone'
              ? 'WIDGET_RENDERER_GONE'
              : 'WIDGET_RENDERER_UNRESPONSIVE',
      })

      if (failure === 'unresponsive') {
        const handler = window.on.mock.calls.find(([event]) => event === failure)?.[1] as
          (() => void) | undefined
        handler?.()
      } else {
        const handler = window.webContents.on.mock.calls.find(
          ([event]) => event === failure,
        )?.[1] as ((...args: unknown[]) => void) | undefined
        if (failure === 'did-fail-load') {
          handler?.({}, -2, 'failed', 'file:///widget.html', true)
        } else {
          handler?.({}, { reason: 'crashed' })
        }
      }

      await rejection
      expect(window.hide).toHaveBeenCalledOnce()
      expect(window.destroy).toHaveBeenCalledOnce()
    },
  )

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
