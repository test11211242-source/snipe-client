import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test.skip(process.platform !== 'win32', 'Native integration smoke runs on Windows only')

// Only this external test launcher replaces network transports. The app, native
// windows/tray, preloads, IPC and persistence are the actual built implementation.
function launcherSource(): string {
  return `
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(${JSON.stringify(pathToFileURL(join(process.cwd(), 'package.json')).href)});
const native = require('electron');
// Windows login registration is owner-only; never alter it during this smoke.
native.app.setLoginItemSettings = () => {};
const probe = globalThis.__desktopSmoke = { trays: [], maxWindows: 0, errors: [] };
native.app.on('browser-window-created', (_event, window) => {
  probe.maxWindows = Math.max(probe.maxWindows, native.BrowserWindow.getAllWindows().length);
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3 || /Content Security Policy|Refused to/i.test(message)) probe.errors.push(message);
  });
});
const setToolTip = native.Tray.prototype.setToolTip;
native.Tray.prototype.setToolTip = function (...args) {
  if (!probe.trays.includes(this)) probe.trays.push(this);
  return setToolTip.apply(this, args);
};
const wsPath = require.resolve('ws');
require(wsPath);
class OfflineSocket extends EventEmitter {
  constructor() { super(); queueMicrotask(() => this.emit('close', 1006)); }
  send() {}
  close() {}
}
require.cache[wsPath].exports = OfflineSocket;
const user = { id: 900001, username: 'integration-fixture', email: 'fixture@example.invalid', role: 'premium', roles: ['premium'] };
globalThis.fetch = async (input) => {
  const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
  const body = ['/api/auth/login', '/api/auth/refresh'].includes(pathname)
    ? { tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }, user }
    : pathname === '/api/auth/me' ? { user } : { detail: 'Offline integration fixture' };
  return new Response(JSON.stringify(body), { status: pathname.startsWith('/api/auth/') ? 200 : 503, headers: { 'content-type': 'application/json' } });
};
native.app.whenReady().then(() => native.session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true })));
Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(join(process.cwd(), 'resources'))} });
// Dynamic import deliberately waits until the test-only transport/native probes exist.
await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'out/main/bootstrap.js')).href)});
`
}

async function mainPage(application: ElectronApplication): Promise<Page> {
  await expect
    .poll(
      () => application.windows().some((page) => page.url().endsWith('/index.html')),
      { timeout: 30_000 },
    )
    .toBe(true)
  const page = application
    .windows()
    .find((candidate) => candidate.url().endsWith('/index.html'))
  if (page === undefined) throw new Error('Main renderer disappeared')
  await expect(page.getByRole('navigation', { name: 'Главная панель' })).toBeVisible()
  return page
}

async function nativeBounds(application: ElectronApplication, entry: string) {
  return application.evaluate(({ BrowserWindow }, suffix) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().endsWith(suffix),
    )
    if (window === undefined) throw new Error(`Missing native window: ${suffix}`)
    return window.getBounds()
  }, entry)
}

test('built app isolates auth, chrome, tray, overlay sizing and restart bounds', async () => {
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), 'cr-tools-integrated-'))
  const launcher = join(directory, 'launch.mjs')
  await writeFile(launcher, launcherSource())
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') environment[key] = value
  }
  let application: ElectronApplication | undefined
  const launch = () =>
    electron.launch({
      executablePath: join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
      args: [launcher, `--user-data-dir=${directory}`],
      env: environment,
    })
  try {
    application = await launch()
    const running = application
    const auth = await application.firstWindow({ timeout: 20_000 })
    await expect(auth.getByRole('heading', { name: 'С возвращением' })).toBeVisible()
    await auth.getByLabel('Почта').fill('fixture@example.invalid')
    await auth.getByLabel('Пароль', { exact: true }).fill('synthetic-only-password')
    await auth.getByRole('button', { name: 'Войти', exact: true }).click()
    const main = await mainPage(application)
    expect(await nativeBounds(application, '/index.html')).toMatchObject({
      width: 1100,
      height: 700,
    })
    expect(
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().endsWith('/index.html'),
        )
        return window?.getContentBounds()
      }),
    ).toEqual(await nativeBounds(application, '/index.html'))
    expect(
      await application.evaluate(() => {
        const probe = (
          globalThis as typeof globalThis & {
            __desktopSmoke: {
              maxWindows: number
              trays: { isDestroyed(): boolean }[]
            }
          }
        ).__desktopSmoke
        return {
          maxWindows: probe.maxWindows,
          tray: probe.trays.some((tray) => !tray.isDestroyed()),
        }
      }),
    ).toEqual({ maxWindows: 2, tray: true })
    await main.getByRole('button', { name: 'Развернуть окно' }).click()
    await expect(main.getByRole('button', { name: 'Восстановить окно' })).toBeVisible()
    await main.getByRole('button', { name: 'Восстановить окно' }).click()
    await main.getByRole('button', { name: 'Свернуть окно' }).click()
    await expect
      .poll(() =>
        running.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().endsWith('/index.html'))
            ?.isMinimized(),
        ),
      )
      .toBe(true)
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().endsWith('/index.html'),
      )
      if (window === undefined) throw new Error('Main native window disappeared')
      window.restore()
      window.show()
    })
    await main.evaluate(() => window.crTools.updateAppSettings({ closeToTray: true }))
    await main.getByRole('button', { name: 'Закрыть окно' }).click()
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().endsWith('/index.html'))
          ?.isVisible(),
      ),
    ).toBe(false)
    await application.evaluate(() => {
      const probe = (
        globalThis as typeof globalThis & {
          __desktopSmoke: { trays: { emit(event: string): void }[] }
        }
      ).__desktopSmoke
      const tray = probe.trays[0]
      if (tray === undefined) throw new Error('Native tray disappeared')
      tray.emit('double-click')
    })
    await expect(main.getByRole('navigation', { name: 'Главная панель' })).toBeVisible()
    await main.evaluate(() => window.crTools.showWidget())
    await expect
      .poll(() => running.windows().some((page) => page.url().endsWith('/widget.html')))
      .toBe(true)
    for (const width of [300, 360, 480, 600, 720]) {
      await main.evaluate(
        (normalWidth) =>
          window.crTools.updateWidgetSettings({ normalWidth, compactMode: false }),
        width,
      )
      await expect
        .poll(async () => (await nativeBounds(running, '/widget.html')).width)
        .toBe(width)
    }
    await application.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().endsWith('/index.html'),
      )
      if (mainWindow === undefined) throw new Error('Main native window disappeared')
      mainWindow.setBounds({ x: 70, y: 80, width: 1000, height: 650 })
      const widget = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().endsWith('/widget.html'),
      )
      if (widget === undefined) throw new Error('Widget native window disappeared')
      widget.setPosition(120, 140)
    })
    await expect
      .poll(async () => (await nativeBounds(running, '/index.html')).width)
      .toBe(1000)
    // Native resize/move persistence is debounced; shutdown then flushes it.
    await main.waitForTimeout(700)
    const mainBounds = await nativeBounds(application, '/index.html')
    const widgetBounds = await nativeBounds(application, '/widget.html')
    const probe = await application.evaluate(() => {
      const value = (
        globalThis as typeof globalThis & {
          __desktopSmoke: { maxWindows: number; errors: string[] }
        }
      ).__desktopSmoke
      return { maxWindows: value.maxWindows, errors: value.errors }
    })
    expect(probe.maxWindows).toBeLessThanOrEqual(3)
    expect(probe.errors).toEqual([])
    await application.close()
    application = await launch()
    const second = application
    const restarted = await mainPage(application)
    expect(await nativeBounds(application, '/index.html')).toEqual(mainBounds)
    await restarted.evaluate(() => window.crTools.showWidget())
    await expect
      .poll(() => second.windows().some((page) => page.url().endsWith('/widget.html')))
      .toBe(true)
    await expect.poll(() => nativeBounds(second, '/widget.html')).toEqual(widgetBounds)
    expect(
      await application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __desktopSmoke: { errors: string[] }
            }
          ).__desktopSmoke.errors,
      ),
    ).toEqual([])
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('running Stop stays neutral at rest, hover and keyboard focus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cr-tools-stop-visual-'))
  const launcher = join(directory, 'launch.cjs')
  await writeFile(
    launcher,
    `const { app, BrowserWindow, ipcMain } = require('electron');
ipcMain.on('visual:fixture', event => { event.returnValue = { results: [{ n: 1, name: 'Voron_17', rating: 2487, clan: 'Северный ветер', minutesAgo: 0, repeatMinutesAgo: 110 }] }; });
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 700, frame: false, webPreferences: { preload: ${JSON.stringify(join(process.cwd(), 'tests/visual/harness-preload.cjs'))}, contextIsolation: true, sandbox: true } });
  await window.loadFile(${JSON.stringify(join(process.cwd(), 'out/renderer/index.html'))});
});`,
  )
  let application: ElectronApplication | undefined
  try {
    application = await electron.launch({
      executablePath: join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
      args: [launcher, `--user-data-dir=${directory}`],
    })
    const page = await application.firstWindow()
    const stop = page.getByRole('button', { name: 'Остановить', exact: true })
    await expect(stop).toBeVisible()
    const background = () =>
      stop.evaluate((element) => getComputedStyle(element).backgroundColor)
    await expect.poll(background).toBe('rgb(23, 24, 28)')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const document = await cdp.send('DOM.getDocument')
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: 'button[title="Остановить"]',
    })
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
    await expect.poll(background).toBe('rgb(31, 33, 38)')
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
    await stop.focus()
    await expect.poll(background).toBe('rgb(23, 24, 28)')
    await page.screenshot({
      path: join(directory, 'main-found-wide.png'),
    })
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})
