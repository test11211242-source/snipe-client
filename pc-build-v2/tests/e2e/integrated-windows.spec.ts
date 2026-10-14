import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

import { CaptureConfigurationRepository } from '../../electron/main/infrastructure/capture-configuration-repository'
import { v4CaptureFixture } from '../capture-fixtures'

test.skip(process.platform !== 'win32', 'Native integration smoke runs on Windows only')

// Only this external test launcher replaces network transports. The app, native
// windows/tray, preloads, IPC and persistence are the actual built implementation.
function launcherSource(connected = false): string {
  const socketSource = `
import { EventEmitter } from 'node:events';
export default class SyntheticSocket extends EventEmitter {
  constructor() {
    super();
    globalThis.__desktopSmoke.sockets.push(this);
    queueMicrotask(() => this.emit(${connected ? "'open'" : "'close', 1006"}));
  }
  send(message) {
    const data = JSON.parse(message);
    if (${connected} && data.type === 'auth') {
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'connection', status: 'connected' })));
    }
    if (data.type === 'ping') queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'pong' })));
  }
  close() {}
}
`
  return `
import { createRequire, registerHooks } from 'node:module';
const require = createRequire(${JSON.stringify(pathToFileURL(join(process.cwd(), 'package.json')).href)});
const native = require('electron');
// Windows login registration is owner-only; never alter it during this smoke.
native.app.setLoginItemSettings = () => {};
const probe = globalThis.__desktopSmoke = { trays: [], sockets: [], maxWindows: 0, errors: [] };
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
// Intercept ESM resolution, not require.cache: ws's ESM wrapper bypasses index.js.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'ws') return {
      url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(socketSource)}),
      shortCircuit: true
    };
    return nextResolve(specifier, context);
  }
});
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

test('pinned overlay closes and native vertical drag cannot crop the content-sized deck', async () => {
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), 'cr-tools-widget-fix-'))
  const launcher = join(directory, 'launch.mjs')
  await writeFile(launcher, launcherSource(true))
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') environment[key] = value
  }
  const application = await electron.launch({
    executablePath: join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
    args: [launcher, `--user-data-dir=${directory}`],
    env: environment,
  })
  try {
    const auth = await application.firstWindow({ timeout: 20_000 })
    await auth.getByLabel('Почта').fill('fixture@example.invalid')
    await auth.getByLabel('Пароль', { exact: true }).fill('synthetic-only-password')
    await auth.getByRole('button', { name: 'Войти', exact: true }).click()
    const main = await mainPage(application)
    await main.evaluate(() => window.crTools.getMonitorView())
    await expect
      .poll(
        async () => (await main.evaluate(() => window.crTools.getRealtimeStatus())).state,
      )
      .toBe('READY')
    await application.evaluate(() => {
      const probe = (
        globalThis as typeof globalThis & {
          __desktopSmoke: { sockets: { emit(event: string, message: string): void }[] }
        }
      ).__desktopSmoke
      const socket = probe.sockets.at(-1)
      if (socket === undefined) throw new Error('Missing synthetic socket')
      socket.emit(
        'message',
        JSON.stringify({
          type: 'ocr_reprocessed',
          data: {
            success: true,
            searched_nickname: 'Voron_17',
            player: {
              name: 'Voron_17',
              tag: '#P0Y',
              rating: 2487,
              clan: 'Северный ветер',
            },
            decks: [
              {
                name: 'PoL',
                cards: Array.from({ length: 8 }, (_, index) => ({
                  name: `Card ${index + 1}`,
                  level: 14,
                })),
              },
            ],
          },
        }),
      )
    })
    for (const state of [
      { alwaysOnTop: true, locked: false, compactMode: false },
      { alwaysOnTop: true, locked: true, compactMode: false },
      { alwaysOnTop: true, locked: true, compactMode: true },
    ]) {
      await main.evaluate((patch) => window.crTools.updateWidgetSettings(patch), state)
      await main.evaluate(() => window.crTools.showWidget())
      await expect
        .poll(() =>
          application.windows().some((page) => page.url().endsWith('/widget.html')),
        )
        .toBe(true)
      const widget = application
        .windows()
        .find((page) => page.url().endsWith('/widget.html'))
      if (widget === undefined) throw new Error('Missing widget renderer')
      await expect(widget.getByRole('heading', { name: 'Voron_17' })).toBeVisible()
      const contentHeight = await widget
        .locator('main')
        .evaluate((element) => Math.ceil(element.getBoundingClientRect().height))
      await expect
        .poll(async () => (await nativeBounds(application, '/widget.html')).height)
        .toBe(contentHeight)
      const native = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().endsWith('/widget.html'),
        )
        if (window === undefined) throw new Error('Missing widget')
        return {
          minimum: window.getMinimumSize(),
          maximum: window.getMaximumSize(),
          handle: window.getNativeWindowHandle().readBigUInt64LE().toString(),
          pinned: window.isAlwaysOnTop(),
        }
      })
      expect(native.pinned).toBe(true)
      expect(native.minimum[1]).toBe(contentHeight)
      expect(native.maximum[1]).toBe(contentHeight)
      if (!state.locked) {
        const drag = join(directory, 'drag.ps1')
        await writeFile(
          drag,
          `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WidgetDrag {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$hwnd = [IntPtr]::new([long]${native.handle})
$rect = New-Object WidgetDrag+Rect
[void][WidgetDrag]::GetWindowRect($hwnd, [ref]$rect)
[void][WidgetDrag]::SetForegroundWindow($hwnd)
$x = [int](($rect.Left + $rect.Right) / 2)
$y = $rect.Bottom - 1
[void][WidgetDrag]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 100
[WidgetDrag]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
for ($step = 1; $step -le 12; $step++) {
  [void][WidgetDrag]::SetCursorPos($x, ($y - $step * 10))
  Start-Sleep -Milliseconds 20
}
[WidgetDrag]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
`,
        )
        execFileSync('pwsh.exe', ['-NoProfile', '-File', drag], {
          timeout: 15_000,
          stdio: 'pipe',
        })
        expect((await nativeBounds(application, '/widget.html')).height).toBe(
          contentHeight,
        )
        const cardsFit = await widget
          .getByRole('list', { name: 'Карты колоды 1' })
          .evaluate(
            (element) => element.getBoundingClientRect().bottom <= window.innerHeight,
          )
        expect(cardsFit).toBe(true)
        await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().endsWith('/widget.html'),
          )
          if (window === undefined) throw new Error('Missing widget')
          window.setSize(480, window.getBounds().height)
        })
        await expect
          .poll(async () =>
            Number(
              await widget
                .locator('main')
                .evaluate((element) =>
                  (element as HTMLElement).style.getPropertyValue('--ow-k'),
                ),
            ),
          )
          .toBe(480 / 360)
        await expect
          .poll(async () => (await nativeBounds(application, '/widget.html')).height)
          .toBe(
            await widget
              .locator('main')
              .evaluate((element) => Math.ceil(element.getBoundingClientRect().height)),
          )
        expect((await nativeBounds(application, '/widget.html')).height).toBeGreaterThan(
          contentHeight,
        )

        // A full↔compact switch changes width and layout at once; no painted frame may
        // cut the card off (it did for ~120 ms until the content-height report).
        await widget.evaluate(() => {
          const probe = globalThis as typeof globalThis & { __switchCrops?: string[] }
          const crops: string[] = []
          probe.__switchCrops = crops
          const sample = (): void => {
            const shell = document.querySelector('main')
            const bottom = shell?.getBoundingClientRect().bottom ?? 0
            if (bottom > window.innerHeight + 1)
              crops.push(
                `${shell?.getAttribute('data-compact') === 'true' ? 'compact' : 'full'} ` +
                  `${String(window.innerWidth)}x${String(window.innerHeight)} ` +
                  `bottom ${String(Math.round(bottom))} at ${String(Math.round(performance.now()))}`,
              )
            requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
        for (const name of [
          'Компактный вид',
          'Полный вид',
          'Компактный вид',
          'Полный вид',
        ]) {
          await widget.locator('main').hover()
          await widget.getByRole('button', { name }).click()
          await expect(widget.locator('main')).toHaveAttribute(
            'data-compact',
            String(name === 'Компактный вид'),
          )
          await expect
            .poll(
              async () =>
                (await nativeBounds(application, '/widget.html')).height ===
                (await widget
                  .locator('main')
                  .evaluate((element) =>
                    Math.ceil(element.getBoundingClientRect().height),
                  )),
            )
            .toBe(true)
          await widget.waitForTimeout(300)
        }
        const crops = await widget.evaluate(
          () =>
            (globalThis as typeof globalThis & { __switchCrops?: string[] })
              .__switchCrops,
        )
        console.log(`mode switch crops: ${JSON.stringify(crops)}`)
        expect(crops).toEqual([])
      }
      await widget.locator('main').hover()
      await widget.getByRole('button', { name: 'Скрыть оверлей' }).click()
      await expect
        .poll(() =>
          application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((candidate) =>
                candidate.webContents.getURL().endsWith('/widget.html'),
              )
              ?.isVisible(),
          ),
        )
        .toBe(false)
      // Late content-height feedback must not raise the hidden topmost HWND either.
      await widget.evaluate(() =>
        window.crToolsWidget.updateSettings({
          contentHeight: Math.ceil(
            document.querySelector('main')?.getBoundingClientRect().height ?? 80,
          ),
        }),
      )
      await widget.waitForTimeout(250)
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((candidate) => candidate.webContents.getURL().endsWith('/widget.html'))
            ?.isVisible(),
        ),
      ).toBe(false)
    }
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
  }
})

/** Native mouse drag by (+72, +48) physical px from a point given as a client-area fraction. */
function nativeDrag(handle: string, fx: number, fy: number): void {
  execFileSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-Command',
      `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WidgetMove {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
$rect = New-Object WidgetMove+Rect
[void][WidgetMove]::GetWindowRect([IntPtr]::new([long]${handle}), [ref]$rect)
$x = [int]($rect.Left + ($rect.Right - $rect.Left) * ${fx})
$y = [int]($rect.Top + ($rect.Bottom - $rect.Top) * ${fy})
[void][WidgetMove]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 150
[WidgetMove]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
for ($step = 1; $step -le 12; $step++) {
  [void][WidgetMove]::SetCursorPos($x + $step * 6, $y + $step * 4)
  Start-Sleep -Milliseconds 20
}
[WidgetMove]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
`,
    ],
    { timeout: 15_000, stdio: 'pipe' },
  )
}

test('waiting overlay stays stable through source retries and drags in both modes', async () => {
  test.setTimeout(180_000)
  const directory = await mkdtemp(join(tmpdir(), 'cr-tools-widget-waiting-'))
  // A saved profile whose window does not exist: auto-start enters WAITING_SOURCE and
  // retries PREFLIGHT on the real backoff ladder, as after closing the emulator.
  await new CaptureConfigurationRepository(join(directory, 'capture-profiles.v5')).save(
    v4CaptureFixture({
      schemaVersion: 1,
      userId: '900001',
      revision: 1,
      fingerprint: 'a'.repeat(64),
      committedAt: '2026-07-12T12:00:00.000Z',
      source: {
        kind: 'window',
        label: 'Closed emulator fixture',
        titleHint: 'CR Tools closed emulator fixture',
        executableLabel: 'closed-emulator-fixture.exe',
      },
      frameSize: { width: 1920, height: 1080 },
      regions: {
        trigger: { x: 0, y: 0, width: 0.2, height: 0.2 },
        normal: { x: 0, y: 0, width: 0.5, height: 0.5 },
        precise: { x: 0, y: 0, width: 1, height: 1 },
      },
      triggerProfile: {
        schemaVersion: 3,
        analyzer: { name: 'cr-tools-trigger-analyzer', version: '2.0.0' },
        innerRect: { x: 0, y: 0, width: 1, height: 1 },
        structureAlgorithm: 'max-channel-scharr-v1',
        structureHash64: '0123456789abcdef',
        matcherMode: 'edge',
        normalizedTemplateSize: { width: 128, height: 128 },
        structureTemplateBase64: 'AAAA',
        edgeTemplateBase64: 'AAAA',
        orientationTemplateBase64: 'AAAA',
        quality: {
          grade: 'medium',
          score: 0.65,
          edgePixelCount: 120,
          edgeCoverage: 0.5,
          keypointsCount: 0,
          cropConfidence: 0,
          cropAreaRatio: 1,
        },
      },
    }),
  )
  const launcher = join(directory, 'launch.mjs')
  await writeFile(launcher, launcherSource(true))
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') environment[key] = value
  }
  const application = await electron.launch({
    executablePath: join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
    args: [launcher, `--user-data-dir=${directory}`],
    env: environment,
  })
  try {
    const auth = await application.firstWindow({ timeout: 20_000 })
    await auth.getByLabel('Почта').fill('fixture@example.invalid')
    await auth.getByLabel('Пароль', { exact: true }).fill('synthetic-only-password')
    await auth.getByRole('button', { name: 'Войти', exact: true }).click()
    const main = await mainPage(application)
    await expect
      .poll(
        async () => {
          const view = await main.evaluate(() => window.crTools.getMonitorView())
          return `${view.state} ${view.error?.code ?? ''}`.trim()
        },
        { timeout: 30_000 },
      )
      .toMatch(/^WAITING_SOURCE/)
    await expect
      .poll(
        async () => (await main.evaluate(() => window.crTools.getRealtimeStatus())).state,
      )
      .toBe('READY')
    // The deck found before the game closed.
    await application.evaluate(() => {
      const probe = (
        globalThis as typeof globalThis & {
          __desktopSmoke: { sockets: { emit(event: string, message: string): void }[] }
        }
      ).__desktopSmoke
      probe.sockets.at(-1)?.emit(
        'message',
        JSON.stringify({
          type: 'ocr_reprocessed',
          data: {
            success: true,
            searched_nickname: 'Voron_17',
            player: {
              name: 'Voron_17',
              tag: '#P0Y',
              rating: 2487,
              clan: 'Северный ветер',
            },
            decks: [
              {
                name: 'PoL',
                cards: Array.from({ length: 8 }, (_, index) => ({
                  name: `Card ${index + 1}`,
                  level: 14,
                })),
              },
            ],
          },
        }),
      )
    })
    await expect
      .poll(
        async () =>
          (await main.evaluate(() => window.crTools.getWidgetStatus())).hasResult,
      )
      .toBe(true)
    await main.evaluate(() =>
      window.crTools.updateWidgetSettings({
        alwaysOnTop: true,
        locked: false,
        compactMode: false,
      }),
    )
    await main.evaluate(() => window.crTools.showWidget())
    await expect
      .poll(() =>
        application.windows().some((page) => page.url().endsWith('/widget.html')),
      )
      .toBe(true)
    const widget = application
      .windows()
      .find((page) => page.url().endsWith('/widget.html'))
    if (widget === undefined) throw new Error('Missing widget renderer')
    await expect(widget.getByRole('heading', { name: 'Ждём окно игры' })).toBeVisible()

    // Bug 1: every retry used to insert the retained deck for the PREFLIGHT attempt.
    await main.evaluate(() => {
      const probe = window as typeof window & { __states?: string[] }
      probe.__states = []
      window.crTools.onMonitorViewChanged((view) => probe.__states?.push(view.state))
    })
    await widget.evaluate(() => {
      const probe = window as typeof window & {
        __deckFlashes?: number
        __cropped?: number
      }
      let shown = false
      probe.__deckFlashes = 0
      probe.__cropped = 0
      new MutationObserver(() => {
        const next = document.querySelector('[aria-label^="Карты колоды"]') !== null
        if (next && !shown) {
          probe.__deckFlashes = (probe.__deckFlashes ?? 0) + 1
          const content =
            document.querySelector('main')?.getBoundingClientRect().height ?? 0
          // The native height still fits the waiting message: the deck is cut off.
          if (content > window.innerHeight + 1)
            probe.__cropped = (probe.__cropped ?? 0) + 1
        }
        shown = next
      }).observe(document.body, { childList: true, subtree: true })
    })
    await expect
      .poll(
        async () =>
          (
            await main.evaluate(
              () => (window as typeof window & { __states?: string[] }).__states ?? [],
            )
          ).filter((state) => state === 'PREFLIGHT').length,
        { timeout: 60_000, intervals: [500] },
      )
      .toBeGreaterThanOrEqual(2)
    // Soft: one run reports the retry flashes and every drag case together.
    const soft = expect.configure({ soft: true })
    const flashes = await widget.evaluate(() => {
      const probe = window as typeof window & {
        __deckFlashes?: number
        __cropped?: number
      }
      return { flashes: probe.__deckFlashes, cropped: probe.__cropped }
    })
    console.log(`waiting retries: ${JSON.stringify(flashes)}`)
    soft(flashes, 'retained deck flashes during PREFLIGHT retries').toEqual({
      flashes: 0,
      cropped: 0,
    })
    await expect(widget.getByRole('heading', { name: 'Ждём окно игры' })).toBeVisible()

    // Bug 2: the waiting overlay must move after every mode switch, pinned or not.
    for (const alwaysOnTop of [true, false]) {
      await main.evaluate(
        (pinned) => window.crTools.updateWidgetSettings({ alwaysOnTop: pinned }),
        alwaysOnTop,
      )
      for (const compact of [false, true, false]) {
        const current = await widget
          .locator('main')
          .evaluate((element) => element.getAttribute('data-compact'))
        if (current !== String(compact)) {
          await widget.locator('main').hover()
          await widget
            .getByRole('button', { name: compact ? 'Компактный вид' : 'Полный вид' })
            .click()
        }
        await expect(widget.locator('main')).toHaveAttribute(
          'data-compact',
          String(compact),
        )
        await expect
          .poll(async () => (await nativeBounds(application, '/widget.html')).height)
          .toBe(
            await widget
              .locator('main')
              .evaluate((element) =>
                Math.max(80, Math.ceil(element.getBoundingClientRect().height)),
              ),
          )
        const handle = await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().endsWith('/widget.html'))
            ?.getNativeWindowHandle()
            .readBigUInt64LE()
            .toString(),
        )
        if (handle === undefined) throw new Error('Missing widget')
        // Full mode keeps its status strip; compact hides it, leaving the waiting body.
        const point = await (
          compact
            ? widget.getByRole('heading', { name: 'Ждём окно игры' })
            : widget.getByText('Ждём окно игры…')
        ).evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return {
            fx: (rect.left + rect.width / 2) / window.innerWidth,
            fy: (rect.top + rect.height / 2) / window.innerHeight,
          }
        })
        const before = await nativeBounds(application, '/widget.html')
        nativeDrag(handle, point.fx, point.fy)
        await soft
          .poll(
            async () => {
              const after = await nativeBounds(application, '/widget.html')
              return { dx: after.x - before.x > 20, dy: after.y - before.y > 10 }
            },
            { message: `drag pinned=${alwaysOnTop} compact=${compact}` },
          )
          .toEqual({ dx: true, dy: true })
      }
    }
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
  }
})
