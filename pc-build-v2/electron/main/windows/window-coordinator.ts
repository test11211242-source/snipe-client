import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BrowserWindow, type WebContents } from 'electron'

import { ApplicationError } from '../../../shared/errors/application-error'
import type { WidgetBounds, WidgetSettings } from '../../../shared/models/widget'
import type { StructuredLogger } from '../infrastructure/structured-logger'

export type WindowKind = 'main' | 'auth' | 'setup' | 'widget'
export type WindowCloseReason =
  'user' | 'auth-transition' | 'setup-transition' | 'shutdown'

interface RegisteredWindow {
  window: BrowserWindow
  rendererUrl: string
  closeReason: WindowCloseReason
  suppressBoundsEvents: boolean
}

function isAllowedRendererUrl(actualValue: string, expectedValue: string): boolean {
  try {
    const actual = new URL(actualValue)
    const expected = new URL(expectedValue)
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search
    )
  } catch {
    return false
  }
}

export class WindowCoordinator {
  readonly #registry = new Map<WindowKind, RegisteredWindow>()
  readonly #closedListeners = new Set<
    (kind: WindowKind, reason: WindowCloseReason) => void
  >()
  readonly #widgetBoundsListeners = new Set<(bounds: WidgetBounds) => void>()

  constructor(private readonly logger: StructuredLogger) {}

  async ensureMainWindow(): Promise<BrowserWindow> {
    const existing = this.#registry.get('main')?.window
    if (existing !== undefined && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }

    const rendererUrl = this.getMainRendererUrl()
    const window = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      show: false,
      backgroundColor: '#080913',
      title: 'CR Tools V2',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/main.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: !import.meta.env.PROD,
      },
    })

    this.register('main', window, rendererUrl)
    window.once('ready-to-show', () => window.show())

    if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
      await window.loadURL(rendererUrl)
    } else {
      await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
    }

    return window
  }

  async ensureAuthWindow(): Promise<BrowserWindow> {
    const existing = this.#registry.get('auth')?.window
    if (existing !== undefined && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }

    const rendererUrl = this.getAuthRendererUrl()
    const window = new BrowserWindow({
      width: 920,
      height: 680,
      minWidth: 680,
      minHeight: 560,
      show: false,
      backgroundColor: '#080913',
      title: 'Вход | CR Tools V2',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/auth.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: !import.meta.env.PROD,
      },
    })

    this.register('auth', window, rendererUrl)
    window.once('ready-to-show', () => window.show())
    if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
      await window.loadURL(rendererUrl)
    } else {
      await window.loadFile(join(import.meta.dirname, '../renderer/auth.html'))
    }
    return window
  }

  async ensureSetupWindow(): Promise<BrowserWindow> {
    const existing = this.#registry.get('setup')?.window
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.show()
      existing.focus()
      return existing
    }

    const rendererUrl = this.getSetupRendererUrl()
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 860,
      minHeight: 640,
      show: false,
      backgroundColor: '#080913',
      title: 'Capture setup | CR Tools V2',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/setup.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: !import.meta.env.PROD,
      },
    })
    this.register('setup', window, rendererUrl)
    window.once('ready-to-show', () => window.show())
    if (process.env['ELECTRON_RENDERER_URL'] !== undefined)
      await window.loadURL(rendererUrl)
    else await window.loadFile(join(import.meta.dirname, '../renderer/setup.html'))
    return window
  }

  async ensureWidgetWindow(settings: WidgetSettings): Promise<void> {
    const existing = this.#registry.get('widget')?.window
    if (existing !== undefined && !existing.isDestroyed()) return

    const rendererUrl = this.getWidgetRendererUrl()
    const positionedBounds =
      settings.bounds.x !== null && settings.bounds.y !== null
        ? { x: settings.bounds.x, y: settings.bounds.y }
        : {}
    const window = new BrowserWindow({
      ...positionedBounds,
      width: settings.bounds.width,
      height: settings.bounds.height,
      minWidth: 340,
      minHeight: 300,
      maxWidth: 720,
      maxHeight: 900,
      show: false,
      alwaysOnTop: settings.alwaysOnTop,
      movable: !settings.locked,
      resizable: !settings.locked,
      opacity: settings.opacity,
      backgroundColor: '#0d0f1c',
      title: 'Opponent | CR Tools V2',
      autoHideMenuBar: true,
      skipTaskbar: true,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/widget.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        devTools: !import.meta.env.PROD,
      },
    })
    this.register('widget', window, rendererUrl)
    if (process.env['ELECTRON_RENDERER_URL'] !== undefined)
      await window.loadURL(rendererUrl)
    else await window.loadFile(join(import.meta.dirname, '../renderer/widget.html'))
  }

  showWidget(): void {
    const window = this.#registry.get('widget')?.window
    if (window === undefined || window.isDestroyed()) return
    window.showInactive()
  }

  hideWidget(): void {
    const window = this.#registry.get('widget')?.window
    if (window === undefined || window.isDestroyed()) return
    window.hide()
  }

  isWidgetVisible(): boolean {
    const window = this.#registry.get('widget')?.window
    return window !== undefined && !window.isDestroyed() && window.isVisible()
  }

  applyWidgetSettings(settings: WidgetSettings): void {
    const registered = this.#registry.get('widget')
    if (registered === undefined || registered.window.isDestroyed()) return
    const window = registered.window
    window.setAlwaysOnTop(settings.alwaysOnTop)
    window.setMovable(!settings.locked)
    window.setResizable(!settings.locked)
    window.setOpacity(settings.opacity)
    registered.suppressBoundsEvents = true
    try {
      if (settings.bounds.x !== null && settings.bounds.y !== null) {
        window.setBounds({
          x: settings.bounds.x,
          y: settings.bounds.y,
          width: settings.bounds.width,
          height: settings.bounds.height,
        })
      } else {
        window.setSize(settings.bounds.width, settings.bounds.height)
      }
    } finally {
      registered.suppressBoundsEvents = false
    }
  }

  onWidgetBoundsChanged(listener: (bounds: WidgetBounds) => void): () => void {
    this.#widgetBoundsListeners.add(listener)
    return () => this.#widgetBoundsListeners.delete(listener)
  }

  focusMainWindow(): void {
    const window = this.#registry.get('main')?.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  focusActiveWindow(): void {
    const active =
      this.#registry.get('setup')?.window ??
      this.#registry.get('main')?.window ??
      this.#registry.get('auth')?.window
    if (active === undefined || active.isDestroyed()) return
    if (active.isMinimized()) active.restore()
    active.show()
    active.focus()
  }

  onWindowClosed(
    listener: (kind: WindowKind, reason: WindowCloseReason) => void,
  ): () => void {
    this.#closedListeners.add(listener)
    return () => this.#closedListeners.delete(listener)
  }

  close(kind: WindowKind, reason: Exclude<WindowCloseReason, 'user'>): void {
    const registered = this.#registry.get(kind)
    if (registered === undefined || registered.window.isDestroyed()) return
    registered.closeReason = reason
    registered.window.destroy()
  }

  assertSender(sender: WebContents, senderUrl: string, expectedKind: WindowKind): void {
    const registered = this.#registry.get(expectedKind)
    const valid =
      registered !== undefined &&
      !registered.window.isDestroyed() &&
      registered.window.webContents.id === sender.id &&
      isAllowedRendererUrl(senderUrl, registered.rendererUrl)

    if (!valid) {
      this.logger.warn('Rejected IPC sender', {
        senderWebContentsId: sender.id,
        senderUrl,
        expectedKind,
      })
      throw new ApplicationError('IPC_SENDER_REJECTED', 'IPC sender is not authorized')
    }
  }

  closeAll(reason: Exclude<WindowCloseReason, 'user'> = 'shutdown'): void {
    for (const registered of this.#registry.values()) {
      registered.closeReason = reason
      if (!registered.window.isDestroyed()) registered.window.destroy()
    }
    this.#registry.clear()
  }

  private register(kind: WindowKind, window: BrowserWindow, rendererUrl: string): void {
    if (this.#registry.has(kind)) {
      throw new ApplicationError(
        'WINDOW_ALREADY_REGISTERED',
        `${kind} window already exists`,
      )
    }

    const registered: RegisteredWindow = {
      window,
      rendererUrl,
      closeReason: 'user',
      suppressBoundsEvents: false,
    }
    this.#registry.set(kind, registered)

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      if (!isAllowedRendererUrl(navigationUrl, rendererUrl)) {
        event.preventDefault()
        this.logger.warn('Blocked renderer navigation', { kind, navigationUrl })
      }
    })
    if (kind === 'widget') {
      const notifyBounds = (): void => {
        if (registered.suppressBoundsEvents || window.isDestroyed()) return
        const bounds = window.getBounds()
        for (const listener of this.#widgetBoundsListeners) listener(bounds)
      }
      window.on('move', notifyBounds)
      window.on('resize', notifyBounds)
    }
    window.on('closed', () => {
      const current = this.#registry.get(kind)
      if (current?.window === window) this.#registry.delete(kind)
      for (const listener of this.#closedListeners) listener(kind, registered.closeReason)
    })
  }

  private getMainRendererUrl(): string {
    return (
      process.env['ELECTRON_RENDERER_URL'] ??
      pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
    )
  }

  private getAuthRendererUrl(): string {
    const developmentUrl = process.env['ELECTRON_RENDERER_URL']
    if (developmentUrl !== undefined) {
      const base = developmentUrl.endsWith('/') ? developmentUrl : `${developmentUrl}/`
      return new URL('auth.html', base).href
    }
    return pathToFileURL(join(import.meta.dirname, '../renderer/auth.html')).href
  }

  private getSetupRendererUrl(): string {
    const developmentUrl = process.env['ELECTRON_RENDERER_URL']
    if (developmentUrl !== undefined) {
      const base = developmentUrl.endsWith('/') ? developmentUrl : `${developmentUrl}/`
      return new URL('setup.html', base).href
    }
    return pathToFileURL(join(import.meta.dirname, '../renderer/setup.html')).href
  }

  private getWidgetRendererUrl(): string {
    const developmentUrl = process.env['ELECTRON_RENDERER_URL']
    if (developmentUrl !== undefined) {
      const base = developmentUrl.endsWith('/') ? developmentUrl : `${developmentUrl}/`
      return new URL('widget.html', base).href
    }
    return pathToFileURL(join(import.meta.dirname, '../renderer/widget.html')).href
  }
}
