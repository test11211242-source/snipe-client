import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, payload: unknown) => unknown>(),
)
vi.mock('electron', () => ({
  session: { defaultSession: {} },
  dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}))

import { createApiError } from '../../../shared/errors/api-error'
import type { AuthView } from '../../../shared/models/auth'
import { ApplicationController } from './application-controller'
import { WidgetController } from '../services/widget-controller'
import { DEFAULT_WIDGET_SETTINGS } from '../infrastructure/widget-settings-repository'
import {
  MAIN_WIDGET_IPC_CHANNELS,
  WidgetStatusResultSchema,
} from '../../../shared/contracts/widget-ipc'
import { registerWidgetIpc } from '../ipc/register-widget-ipc'
import { monitorViewFixture } from '../../../tests/monitor-fixtures'

function authenticated(userId: string): AuthView {
  return {
    state: 'AUTHENTICATED',
    user: {
      id: userId,
      username: `user-${userId}`,
      email: `${userId}@example.com`,
      role: 'premium',
      roles: ['premium'],
    },
    error: null,
  }
}

describe('ApplicationController user context', () => {
  it.each(['ready', 'logout', 'switch', 'disk-retry', 'refresh'])(
    'fences a real deferred widget load before renderer status: %s',
    async (mode) => {
      let release!: () => void
      const loading = new Promise<void>((resolve) => {
        release = resolve
      })
      const repository = {
        load: vi.fn(async () => {
          await loading
          return { ...DEFAULT_WIDGET_SETTINGS }
        }),
        save: vi.fn(),
      }
      if (mode === 'disk-retry')
        repository.load.mockRejectedValueOnce(new Error('disk denied'))
      const windows = {
        ensureMainWindow: vi.fn(() => {
          const status = handlers.get(MAIN_WIDGET_IPC_CHANNELS.getStatus)
          if (status === undefined) throw new Error('Missing widget status handler')
          const event = {
            sender: { id: 1 },
            senderFrame: { url: 'file:///app/index.html' },
          }
          expect(WidgetStatusResultSchema.parse(status(event, {})).settings).toEqual(
            DEFAULT_WIDGET_SETTINGS,
          )
          return Promise.resolve()
        }),
        ensureAuthWindow: vi.fn(),
        close: vi.fn(),
        isWidgetVisible: () => false,
        onWidgetBoundsChanged: vi.fn(() => vi.fn()),
        assertSender: vi.fn(),
      }
      const monitor = {
        stop: vi.fn(),
        setUserContext: vi.fn(),
        getLatestResult: () => null,
        subscribeResults: vi.fn(() => vi.fn()),
        subscribeViews: vi.fn(() => vi.fn()),
        getCurrentView: () => monitorViewFixture(),
      }
      const widget = new WidgetController(monitor, repository as never, windows as never)
      registerWidgetIpc({
        windows,
        widget,
        images: {},
        logger: { info: vi.fn() },
      } as never)
      const controller = new ApplicationController(
        {} as never,
        windows as never,
        { getView: () => ({ autoStartMonitoring: false }) } as never,
        { error: vi.fn() } as never,
        {} as never,
        { start: vi.fn(), stop: vi.fn() } as never,
        {} as never,
        { cancelForAuthTransition: vi.fn() } as never,
        monitor as never,
        widget,
        { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() } as never,
        { start: vi.fn(), stop: vi.fn() } as never,
        { start: vi.fn(), stop: vi.fn() } as never,
        { start: vi.fn(), stop: vi.fn() } as never,
        {} as never,
        { stop: vi.fn() } as never,
        {} as never,
      )
      const internal = controller as unknown as {
        syncWindows: (view: AuthView) => Promise<void>
        queueWindowSync: (view: AuthView) => void
      }
      const start =
        mode === 'refresh'
          ? Promise.resolve(internal.queueWindowSync(authenticated('A')))
          : internal.syncWindows(authenticated('A'))
      await vi.waitFor(() => expect(repository.load).toHaveBeenCalled())
      expect(windows.ensureMainWindow).not.toHaveBeenCalled()
      if (mode === 'logout' || mode === 'switch') {
        internal.queueWindowSync(
          mode === 'logout'
            ? { state: 'UNAUTHENTICATED', user: null, error: null }
            : authenticated('B'),
        )
      }
      if (mode === 'refresh') {
        internal.queueWindowSync(authenticated('A'))
        internal.queueWindowSync(authenticated('A'))
      }
      release()
      await start
      if (mode === 'logout') {
        await vi.waitFor(() => expect(windows.ensureAuthWindow).toHaveBeenCalled())
        expect(windows.ensureMainWindow).not.toHaveBeenCalled()
        expect(() => widget.getStatus()).toThrow()
      } else {
        await vi.waitFor(() => expect(windows.ensureMainWindow).toHaveBeenCalledOnce())
        if (mode === 'switch') expect(repository.load).toHaveBeenLastCalledWith('B')
        else {
          await internal.syncWindows(authenticated('A'))
          expect(repository.load).toHaveBeenCalledTimes(mode === 'disk-retry' ? 2 : 1)
        }
      }
    },
  )
  it.each([null, 'Выполнен вход на другом устройстве'])(
    'opens login and clears user services across A -> exit (%s) -> B',
    async (message) => {
      const windows = {
        ensureMainWindow: vi.fn().mockResolvedValue(undefined),
        ensureAuthWindow: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      }
      const realtime = { start: vi.fn(), stop: vi.fn() }
      const setup = {
        getSession: vi.fn(() => {
          throw new Error('no setup')
        }),
        cancel: vi.fn(),
        cancelForAuthTransition: vi.fn(),
      }
      const monitor = {
        stop: vi.fn().mockResolvedValue({ state: 'STOPPED' }),
        setUserContext: vi.fn(),
      }
      const widget = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const images = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() }
      const notifications = { start: vi.fn(), stop: vi.fn() }
      const reprocessedResults = { start: vi.fn(), stop: vi.fn() }
      const streamer = {
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const capturePreparations = { stop: vi.fn().mockResolvedValue(undefined) }
      const controller = new ApplicationController(
        {} as never,
        windows as never,
        { getView: () => ({ autoStartMonitoring: false }) } as never,
        {} as never,
        {} as never,
        realtime as never,
        {} as never,
        setup as never,
        monitor as never,
        widget as never,
        images as never,
        notifications as never,
        reprocessedResults as never,
        streamer as never,
        {} as never,
        capturePreparations as never,
        {} as never,
      )
      const syncWindows = (
        controller as unknown as { syncWindows: (view: AuthView) => Promise<void> }
      ).syncWindows.bind(controller)

      await syncWindows(authenticated('A'))
      await syncWindows({
        state: 'UNAUTHENTICATED',
        user: null,
        error:
          message === null ? null : createApiError('UNAUTHORIZED', message, false, 401),
      })
      expect(windows.ensureAuthWindow).toHaveBeenCalledOnce()
      expect(windows.close).toHaveBeenCalledWith('main', 'auth-transition')
      expect(windows.ensureAuthWindow.mock.invocationCallOrder[0]).toBeLessThan(
        windows.close.mock.invocationCallOrder.at(-1) ?? 0,
      )
      await syncWindows(authenticated('B'))

      expect(monitor.setUserContext).toHaveBeenNthCalledWith(1, 'A')
      expect(monitor.setUserContext).toHaveBeenNthCalledWith(2, null)
      expect(monitor.setUserContext).toHaveBeenNthCalledWith(3, 'B')
      expect(widget.stop).toHaveBeenCalledWith('auth-transition')
      expect(images.stop).toHaveBeenCalledTimes(3)
      expect(images.start).toHaveBeenCalledTimes(2)
      expect(reprocessedResults.stop).toHaveBeenCalled()
      expect(notifications.stop).toHaveBeenCalled()
      expect(widget.start).toHaveBeenNthCalledWith(1, 'A')
      expect(widget.start).toHaveBeenNthCalledWith(2, 'B')
      expect(capturePreparations.stop).toHaveBeenCalled()
      expect(reprocessedResults.start).toHaveBeenNthCalledWith(1, 'A')
      expect(reprocessedResults.start).toHaveBeenNthCalledWith(2, 'B')
      expect(setup.cancelForAuthTransition).toHaveBeenCalledTimes(3)
    },
  )
})

function autoStartHarness(configured: boolean, autoStartMonitoring = true) {
  const monitor = {
    stop: vi.fn().mockResolvedValue(undefined),
    setUserContext: vi.fn(),
    getView: vi.fn().mockResolvedValue(
      monitorViewFixture({
        readiness: {
          authenticated: true,
          captureConfigured: configured,
          sourceAvailable: false,
        },
      }),
    ),
    start: vi
      .fn()
      .mockResolvedValue(
        monitorViewFixture({ state: 'WAITING_SOURCE', runIntent: true }),
      ),
  }
  const windows = {
    ensureMainWindow: vi.fn().mockResolvedValue(undefined),
    ensureAuthWindow: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  }
  const service = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }
  const controller = new ApplicationController(
    {} as never,
    windows as never,
    { getView: () => ({ autoStartMonitoring }) } as never,
    { warn: vi.fn(), error: vi.fn() } as never,
    {} as never,
    service as never,
    {} as never,
    { cancelForAuthTransition: vi.fn() } as never,
    monitor as never,
    service as never,
    service as never,
    service as never,
    service as never,
    service as never,
    {} as never,
    service as never,
    {} as never,
  )
  // Exercise the existing main-owned auth synchronization without booting real Electron.
  const internal = controller as unknown as {
    syncWindows: (view: AuthView) => Promise<void>
  }
  return {
    monitor,
    windows,
    sync: (view: AuthView) => internal.syncWindows(view),
  }
}

describe('automatic monitor launch intent', () => {
  it('starts a configured but missing source once, not again on restore or auth refresh', async () => {
    const test = autoStartHarness(true)
    await test.sync(authenticated('A'))
    expect(test.monitor.start).toHaveBeenCalledOnce()
    await test.monitor.stop()
    await test.sync(authenticated('A'))
    await test.sync(authenticated('A'))
    expect(test.monitor.start).toHaveBeenCalledOnce()
    await test.sync({ state: 'UNAUTHENTICATED', user: null, error: null })
    await test.sync(authenticated('A'))
    expect(test.monitor.start).toHaveBeenCalledOnce()
    await test.sync(authenticated('B'))
    expect(test.monitor.start).toHaveBeenCalledTimes(2)
  })

  it.each([
    [false, true],
    [true, false],
  ])('does not auto-start for configured=%s enabled=%s', async (configured, enabled) => {
    const test = autoStartHarness(configured, enabled)
    await test.sync(authenticated('A'))
    expect(test.windows.ensureMainWindow).toHaveBeenCalledOnce()
    expect(test.monitor.start).not.toHaveBeenCalled()
  })
})

describe('review regression startup visibility and auto-start', () => {
  it('#2 consumes launch-in-tray before user-driven logout and login transitions', async () => {
    const args = [...process.argv]
    process.argv.push('--launch-in-tray')
    try {
      const test = autoStartHarness(false)
      await test.sync(authenticated('A'))
      expect(test.windows.ensureMainWindow).toHaveBeenLastCalledWith(false)
      await test.sync({ state: 'UNAUTHENTICATED', user: null, error: null })
      expect(test.windows.ensureAuthWindow).toHaveBeenLastCalledWith(true)
      await test.sync(authenticated('B'))
      expect(test.windows.ensureMainWindow).toHaveBeenLastCalledWith(true)
    } finally {
      process.argv = args
    }
  })
  it('#10 does not serialize an unfinished monitor start with window transitions', async () => {
    const test = autoStartHarness(true)
    const gate = Promise.withResolvers<ReturnType<typeof monitorViewFixture>>()
    test.monitor.start.mockReturnValue(gate.promise)
    let returned = false
    const sync = test.sync(authenticated('A')).then(() => {
      returned = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const finishedBeforeMonitor = returned
    gate.resolve(monitorViewFixture())
    await sync
    expect(finishedBeforeMonitor).toBe(true)
  })
  it('#10 isolates auto-start read failures from a successful window transition', async () => {
    const test = autoStartHarness(true)
    test.monitor.getView.mockRejectedValue(new Error('Corrupt capture store'))
    await expect(test.sync(authenticated('A'))).resolves.toBeUndefined()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(test.windows.ensureMainWindow).toHaveBeenCalledOnce()
    await test.sync({ state: 'UNAUTHENTICATED', user: null, error: null })
    expect(test.windows.ensureAuthWindow).toHaveBeenCalledOnce()
  })
})

describe('review regression detached auto-start generation', () => {
  it('#10 never launches a stale user after an auth transition during the readiness read', async () => {
    const test = autoStartHarness(true)
    const gate = Promise.withResolvers<ReturnType<typeof monitorViewFixture>>()
    test.monitor.getView.mockReturnValueOnce(gate.promise)
    await test.sync(authenticated('A'))
    await test.sync({ state: 'UNAUTHENTICATED', user: null, error: null })
    gate.resolve(
      monitorViewFixture({
        readiness: {
          authenticated: true,
          captureConfigured: true,
          sourceAvailable: false,
        },
      }),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(test.monitor.start).not.toHaveBeenCalled()
  })
})
