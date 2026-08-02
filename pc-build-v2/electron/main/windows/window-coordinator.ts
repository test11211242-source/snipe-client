import { join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BrowserWindow, screen, type WebContents } from 'electron'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  WIDGET_MAX_HEIGHT,
  WIDGET_MAX_WIDTH,
  WIDGET_MIN_HEIGHT,
  WIDGET_MIN_WIDTH,
  WidgetBoundsSchema,
  type WidgetBounds,
  type WidgetSettings,
} from '../../../shared/models/widget'
import type { StructuredLogger } from '../infrastructure/structured-logger'

export type WindowKind = 'main' | 'auth' | 'setup' | 'widget'
export type WindowCloseReason =
  'user' | 'auth-transition' | 'setup-transition' | 'shutdown'

interface RegisteredWindow {
  window: BrowserWindow
  rendererUrl: string
  closeReason: WindowCloseReason
  suppressBoundsEvents: boolean
  widgetRendererReady: boolean
  widgetReadiness: WidgetReadiness | null
  widgetInitialNavigationPending: boolean
}

interface WidgetReadiness {
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: () => void
  reject: (error: unknown) => void
}

export const WIDGET_RENDERER_READY_TIMEOUT_MS = 10_000

export interface WorkAreaBounds {
  x: number
  y: number
  width: number
  height: number
}

interface WindowSize {
  width: number
  height: number
}

export function fitWindowBounds(
  workArea: WorkAreaBounds,
  desired: WindowSize,
  minimum: WindowSize,
): WorkAreaBounds & { minWidth: number; minHeight: number } {
  const width = Math.max(1, Math.min(desired.width, workArea.width))
  const height = Math.max(1, Math.min(desired.height, workArea.height))
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(minimum.width, width),
    minHeight: Math.min(minimum.height, height),
  }
}

function overlap(left: WorkAreaBounds, right: WorkAreaBounds): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  )
  return width * height
}

export function clampWidgetBoundsToWorkAreas(
  bounds: WidgetBounds,
  workAreas: readonly WorkAreaBounds[],
): Omit<WidgetBounds, 'x' | 'y'> & { x: number; y: number } {
  const firstWorkArea = workAreas.at(0)
  if (firstWorkArea === undefined) {
    return { ...bounds, x: bounds.x ?? 0, y: bounds.y ?? 0 }
  }
  const positioned = bounds.x !== null && bounds.y !== null
  const saved = {
    x: bounds.x ?? firstWorkArea.x,
    y: bounds.y ?? firstWorkArea.y,
    width: bounds.width,
    height: bounds.height,
  }
  let selected = firstWorkArea
  if (positioned) {
    let bestOverlap = 0
    for (const candidate of workAreas) {
      const candidateOverlap = overlap(saved, candidate)
      if (candidateOverlap > bestOverlap) {
        selected = candidate
        bestOverlap = candidateOverlap
      }
    }
  }
  const width = Math.max(1, Math.min(bounds.width, selected.width))
  const height = Math.max(1, Math.min(bounds.height, selected.height))
  const centeredX = selected.x + Math.floor((selected.width - width) / 2)
  const centeredY = selected.y + Math.floor((selected.height - height) / 2)
  return {
    x: positioned
      ? Math.min(Math.max(saved.x, selected.x), selected.x + selected.width - width)
      : centeredX,
    y: positioned
      ? Math.min(Math.max(saved.y, selected.y), selected.y + selected.height - height)
      : centeredY,
    width,
    height,
  }
}

export function persistableWidgetBounds(bounds: WorkAreaBounds): WidgetBounds {
  return WidgetBoundsSchema.parse({
    x: Math.min(32_767, Math.max(-32_768, Math.round(bounds.x))),
    y: Math.min(32_767, Math.max(-32_768, Math.round(bounds.y))),
    width: Math.min(
      WIDGET_MAX_WIDTH,
      Math.max(WIDGET_MIN_WIDTH, Math.round(bounds.width)),
    ),
    height: Math.min(
      WIDGET_MAX_HEIGHT,
      Math.max(WIDGET_MIN_HEIGHT, Math.round(bounds.height)),
    ),
  })
}

export function resolveDevelopmentRendererUrl(
  value: string | undefined,
  entryPoint: string,
  production: boolean,
): string | null {
  if (production || value === undefined) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(hostname) ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null
    }
    if (entryPoint === 'index.html') return url.href
    url.search = ''
    url.hash = ''
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return new URL(entryPoint, url).href
  } catch {
    return null
  }
}

export function isAllowedRendererUrl(
  actualValue: string,
  expectedValue: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const actual = new URL(actualValue)
    const expected = new URL(expectedValue)
    if (
      actual.protocol !== expected.protocol ||
      actual.host !== expected.host ||
      actual.search !== expected.search
    ) {
      return false
    }
    if (actual.protocol !== 'file:') return actual.pathname === expected.pathname

    const actualPath = normalize(fileURLToPath(actual))
    const expectedPath = normalize(fileURLToPath(expected))
    return platform === 'win32'
      ? actualPath.toLowerCase() === expectedPath.toLowerCase()
      : actualPath === expectedPath
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
  #widgetLoadPromise: Promise<void> | null = null

  constructor(private readonly logger: StructuredLogger) {}

  async ensureMainWindow(): Promise<BrowserWindow> {
    const existing = this.#registry.get('main')?.window
    if (existing !== undefined && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }

    const renderer = this.getRenderer('index.html')
    const bounds = fitWindowBounds(
      screen.getPrimaryDisplay().workArea,
      { width: 1180, height: 760 },
      { width: 720, height: 560 },
    )
    const window = new BrowserWindow({
      ...bounds,
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

    this.register('main', window, renderer.url)
    window.once('ready-to-show', () => window.show())

    if (renderer.development) {
      await window.loadURL(renderer.url)
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

    const renderer = this.getRenderer('auth.html')
    const bounds = fitWindowBounds(
      screen.getPrimaryDisplay().workArea,
      { width: 920, height: 680 },
      { width: 680, height: 560 },
    )
    const window = new BrowserWindow({
      ...bounds,
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

    this.register('auth', window, renderer.url)
    window.once('ready-to-show', () => window.show())
    if (renderer.development) {
      await window.loadURL(renderer.url)
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

    const renderer = this.getRenderer('setup.html')
    const bounds = fitWindowBounds(
      screen.getPrimaryDisplay().workArea,
      { width: 1280, height: 860 },
      { width: 860, height: 640 },
    )
    const window = new BrowserWindow({
      ...bounds,
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
    this.register('setup', window, renderer.url)
    window.once('ready-to-show', () => window.show())
    if (renderer.development) await window.loadURL(renderer.url)
    else await window.loadFile(join(import.meta.dirname, '../renderer/setup.html'))
    return window
  }

  async ensureWidgetWindow(settings: WidgetSettings): Promise<void> {
    const registered = this.#registry.get('widget')
    const existing = registered?.window
    if (existing !== undefined && !existing.isDestroyed()) {
      if (this.#widgetLoadPromise !== null) return this.#widgetLoadPromise
      return
    }
    if (registered !== undefined) this.#registry.delete('widget')

    const renderer = this.getRenderer('widget.html')
    const workAreas = screen.getAllDisplays().map((display) => display.workArea)
    const bounds = clampWidgetBoundsToWorkAreas(settings.bounds, workAreas)
    const window = new BrowserWindow({
      ...bounds,
      minWidth: Math.min(WIDGET_MIN_WIDTH, bounds.width),
      minHeight: Math.min(WIDGET_MIN_HEIGHT, bounds.height),
      maxWidth: WIDGET_MAX_WIDTH,
      maxHeight: WIDGET_MAX_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: settings.alwaysOnTop,
      movable: !settings.locked,
      resizable: !settings.locked,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      opacity: settings.opacity,
      backgroundColor: '#00000000',
      hasShadow: true,
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
    window.setAspectRatio(0)
    const registeredWidget = this.register('widget', window, renderer.url)
    const ready = this.armWidgetReadiness(registeredWidget)
    const load = Promise.resolve()
      .then(() =>
        renderer.development
          ? window.loadURL(renderer.url)
          : window.loadFile(join(import.meta.dirname, '../renderer/widget.html')),
      )
      .finally(() => {
        registeredWidget.widgetInitialNavigationPending = false
      })
    const operation = Promise.all([load, ready])
      .then(() => undefined)
      .catch((error: unknown) => {
        this.failWidgetWindow(window, error)
        throw error
      })
      .finally(() => {
        if (this.#widgetLoadPromise === operation) this.#widgetLoadPromise = null
      })
    this.#widgetLoadPromise = operation
    return operation
  }

  showWidget(): void {
    const registered = this.#registry.get('widget')
    const window = registered?.window
    if (
      registered?.widgetRendererReady !== true ||
      window === undefined ||
      window.isDestroyed()
    ) {
      return
    }
    window.show()
    window.focus()
    this.restoreWidgetTopmost(window)
  }

  showWidgetInactive(): void {
    const registered = this.#registry.get('widget')
    const window = registered?.window
    if (
      registered?.widgetRendererReady !== true ||
      window === undefined ||
      window.isDestroyed()
    ) {
      return
    }
    window.showInactive()
    this.restoreWidgetTopmost(window)
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

  sendToRenderer(kind: WindowKind, channel: string, payload: unknown): boolean {
    const window = this.#registry.get(kind)?.window
    if (window === undefined || window.isDestroyed()) return false
    try {
      window.webContents.send(channel, payload)
      return true
    } catch (error) {
      this.logger.warn('Renderer event delivery failed', { kind, channel, error })
      return false
    }
  }

  applyWidgetSettings(settings: WidgetSettings): void {
    const registered = this.#registry.get('widget')
    if (registered === undefined || registered.window.isDestroyed()) return
    const window = registered.window
    window.setAlwaysOnTop(settings.alwaysOnTop, 'normal')
    if (settings.alwaysOnTop) window.moveTop()
    window.setMovable(!settings.locked)
    window.setResizable(!settings.locked)
    window.setMinimumSize(WIDGET_MIN_WIDTH, WIDGET_MIN_HEIGHT)
    window.setAspectRatio(0)
    window.setOpacity(settings.opacity)
    registered.suppressBoundsEvents = true
    try {
      const bounds = clampWidgetBoundsToWorkAreas(
        settings.bounds,
        screen.getAllDisplays().map((display) => display.workArea),
      )
      window.setBounds(bounds)
    } finally {
      registered.suppressBoundsEvents = false
    }
  }

  onWidgetBoundsChanged(listener: (bounds: WidgetBounds) => void): () => void {
    this.#widgetBoundsListeners.add(listener)
    return () => this.#widgetBoundsListeners.delete(listener)
  }

  markWidgetRendererReady(): void {
    const registered = this.#registry.get('widget')
    if (registered === undefined || registered.window.isDestroyed()) {
      throw new ApplicationError('WIDGET_NOT_AVAILABLE', 'Widget window is not available')
    }
    if (registered.widgetRendererReady) return
    const readiness = registered.widgetReadiness
    if (readiness === null || readiness.settled) {
      throw new ApplicationError('WIDGET_NOT_LOADING', 'Widget renderer is not loading')
    }
    try {
      registered.window.setIgnoreMouseEvents(false)
    } catch (error) {
      this.failWidgetWindow(registered.window, error)
      throw error
    }
    registered.widgetRendererReady = true
    this.resolveWidgetReadiness(readiness)
  }

  private restoreWidgetTopmost(window: BrowserWindow): void {
    if (!window.isAlwaysOnTop()) return
    window.setAlwaysOnTop(true, 'normal')
    window.moveTop()
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
    if (kind === 'widget') {
      this.rejectWidgetReadiness(
        registered,
        new ApplicationError('WIDGET_CLOSED', 'Widget window was closed while loading'),
      )
    }
    registered.window.destroy()
  }

  assertSender(
    sender: WebContents,
    senderUrl: string,
    expectedKind: WindowKind | readonly WindowKind[],
  ): void {
    const expectedKinds: readonly WindowKind[] = Array.isArray(expectedKind)
      ? (expectedKind as readonly WindowKind[])
      : [expectedKind as WindowKind]
    const valid = expectedKinds.some((kind) => {
      const registered = this.#registry.get(kind)
      return (
        registered !== undefined &&
        !registered.window.isDestroyed() &&
        registered.window.webContents.id === sender.id &&
        isAllowedRendererUrl(senderUrl, registered.rendererUrl)
      )
    })

    if (!valid) {
      this.logger.warn('Rejected IPC sender', {
        senderWebContentsId: sender.id,
        senderUrl,
        expectedKinds,
      })
      throw new ApplicationError('IPC_SENDER_REJECTED', 'IPC sender is not authorized')
    }
  }

  closeAll(reason: Exclude<WindowCloseReason, 'user'> = 'shutdown'): void {
    for (const registered of this.#registry.values()) {
      registered.closeReason = reason
      this.rejectWidgetReadiness(
        registered,
        new ApplicationError('WIDGET_CLOSED', 'Widget window was closed while loading'),
      )
      if (!registered.window.isDestroyed()) registered.window.destroy()
    }
    this.#registry.clear()
  }

  private register(
    kind: WindowKind,
    window: BrowserWindow,
    rendererUrl: string,
  ): RegisteredWindow {
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
      widgetRendererReady: kind !== 'widget',
      widgetReadiness: null,
      widgetInitialNavigationPending: kind === 'widget',
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
      window.webContents.on(
        'did-start-navigation',
        (_event, navigationUrl, isInPlace, isMainFrame) => {
          if (
            !isMainFrame ||
            isInPlace ||
            !isAllowedRendererUrl(navigationUrl, rendererUrl)
          ) {
            return
          }
          if (registered.widgetInitialNavigationPending) {
            registered.widgetInitialNavigationPending = false
            return
          }
          void this.armWidgetReadiness(registered).catch(() => undefined)
        },
      )
      const notifyBounds = (): void => {
        if (registered.suppressBoundsEvents || window.isDestroyed()) return
        const bounds = persistableWidgetBounds(window.getBounds())
        for (const listener of this.#widgetBoundsListeners) {
          try {
            listener(bounds)
          } catch (error) {
            this.logger.warn('Widget bounds listener failed', { error })
          }
        }
      }
      window.on('move', notifyBounds)
      window.on('resize', notifyBounds)
      window.on('blur', () => this.restoreWidgetTopmost(window))
      window.webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
          if (!isMainFrame) return
          this.logger.warn('Widget renderer failed to load', {
            errorCode,
            errorDescription,
            validatedUrl,
          })
          this.failWidgetWindow(
            window,
            new ApplicationError('WIDGET_LOAD_FAILED', 'Widget renderer failed to load'),
          )
        },
      )
      window.webContents.on('render-process-gone', (_event, details) => {
        this.logger.warn('Widget renderer process exited', { reason: details.reason })
        this.failWidgetWindow(
          window,
          new ApplicationError('WIDGET_RENDERER_GONE', 'Widget renderer process exited'),
        )
      })
      window.on('unresponsive', () => {
        this.logger.warn('Widget renderer became unresponsive')
        this.failWidgetWindow(
          window,
          new ApplicationError(
            'WIDGET_RENDERER_UNRESPONSIVE',
            'Widget renderer became unresponsive',
          ),
        )
      })
    }
    window.on('closed', () => {
      this.rejectWidgetReadiness(
        registered,
        new ApplicationError('WIDGET_CLOSED', 'Widget window was closed while loading'),
      )
      const current = this.#registry.get(kind)
      if (current?.window === window) this.#registry.delete(kind)
      for (const listener of this.#closedListeners) listener(kind, registered.closeReason)
    })
    return registered
  }

  private armWidgetReadiness(registered: RegisteredWindow): Promise<void> {
    const window = registered.window
    this.rejectWidgetReadiness(
      registered,
      new ApplicationError(
        'WIDGET_RENDERER_SUPERSEDED',
        'Widget renderer navigation was superseded',
      ),
    )
    registered.widgetRendererReady = false
    window.setIgnoreMouseEvents(true)
    const ready = new Promise<void>((resolve, reject) => {
      registered.widgetReadiness = {
        settled: false,
        timer: null,
        resolve,
        reject,
      }
    })
    const readiness = registered.widgetReadiness
    if (readiness === null) throw new Error('Widget readiness was not initialized')
    readiness.timer = setTimeout(() => {
      this.failWidgetWindow(
        window,
        new ApplicationError(
          'WIDGET_RENDERER_TIMEOUT',
          'Widget renderer did not become ready in time',
        ),
      )
    }, WIDGET_RENDERER_READY_TIMEOUT_MS)
    return ready
  }

  private resolveWidgetReadiness(readiness: WidgetReadiness): void {
    if (readiness.settled) return
    readiness.settled = true
    if (readiness.timer !== null) clearTimeout(readiness.timer)
    readiness.timer = null
    readiness.resolve()
  }

  private rejectWidgetReadiness(registered: RegisteredWindow, error: unknown): void {
    const readiness = registered.widgetReadiness
    if (readiness === null || readiness.settled) return
    readiness.settled = true
    if (readiness.timer !== null) clearTimeout(readiness.timer)
    readiness.timer = null
    readiness.reject(error)
  }

  private failWidgetWindow(window: BrowserWindow, error: unknown): void {
    const registered = this.#registry.get('widget')
    if (registered?.window === window) {
      registered.closeReason = 'auth-transition'
      this.rejectWidgetReadiness(registered, error)
      this.#registry.delete('widget')
    }
    if (window.isDestroyed()) return
    window.hide()
    window.destroy()
  }

  private getRenderer(entryPoint: string): {
    url: string
    development: boolean
  } {
    const developmentUrl = resolveDevelopmentRendererUrl(
      process.env['ELECTRON_RENDERER_URL'],
      entryPoint,
      import.meta.env.PROD,
    )
    if (developmentUrl !== null) return { url: developmentUrl, development: true }
    return {
      url: pathToFileURL(join(import.meta.dirname, `../renderer/${entryPoint}`)).href,
      development: false,
    }
  }
}
