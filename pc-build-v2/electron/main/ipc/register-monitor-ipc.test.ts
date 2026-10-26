import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  removeHandler: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        electron.handlers.set(channel, handler)
      },
    ),
    removeHandler: electron.removeHandler,
  },
}))

import { MONITOR_IPC_CHANNELS } from '../../../shared/contracts/monitor-ipc'
import type { MonitorView } from '../../../shared/models/monitor'
import { registerMonitorIpc } from './register-monitor-ipc'

const view: MonitorView = {
  seq: 1,
  state: 'READY',
  preferences: { deckMode: 'pol' },
  readiness: {
    authenticated: true,
    captureConfigured: true,
    sourceAvailable: true,
  },
  error: null,
  startedAt: '2026-07-12T12:00:00.000Z',
  stats: {
    triggers: 1,
    requests: 1,
    droppedActions: 0,
    playersFound: 1,
    playersNotFound: 0,
    recognitionFailures: 0,
    serviceErrors: 0,
  },
  results: [],
  runIntent: false,
  search: null,
  session: null,
  summary: null,
  historyError: null,
  geometry: null,
  sourceMinimized: false,
  recovery: null,
}

beforeEach(() => {
  electron.handlers.clear()
  electron.removeHandler.mockClear()
})

describe('monitor IPC result events', () => {
  it('opens the waiting widget before monitoring is ready', async () => {
    let ready!: (view: MonitorView) => void
    const starting = new Promise<MonitorView>((resolve) => {
      ready = resolve
    })
    const widget = { show: vi.fn().mockResolvedValue({}) }
    registerMonitorIpc({
      windows: { assertSender: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn() },
      widget,
      monitor: {
        start: vi.fn().mockReturnValue(starting),
        subscribeViews: vi.fn(() => () => undefined),
      },
    } as never)
    const handler = electron.handlers.get(MONITOR_IPC_CHANNELS.start)
    if (handler === undefined) throw new Error('Missing start handler')
    const result = handler(
      { senderFrame: { url: 'file:///app/index.html' }, sender: {} },
      {},
    )
    expect(widget.show).toHaveBeenCalledOnce()
    ready(view)
    await expect(result).resolves.toEqual(view)
  })

  it('keeps monitoring running if the widget fails to open', async () => {
    const warn = vi.fn()
    registerMonitorIpc({
      windows: { assertSender: vi.fn() },
      logger: { info: vi.fn(), warn },
      widget: { show: vi.fn().mockRejectedValue(new Error('window failure')) },
      monitor: {
        start: vi.fn().mockResolvedValue(view),
        subscribeViews: vi.fn(() => () => undefined),
      },
    } as never)
    const handler = electron.handlers.get(MONITOR_IPC_CHANNELS.start)
    if (handler === undefined) throw new Error('Missing start handler')
    await expect(
      handler({ senderFrame: { url: 'file:///app/index.html' }, sender: {} }, {}),
    ).resolves.toEqual(view)
    expect(warn).toHaveBeenCalledOnce()
  })
  it('pushes the current validated view and disposes the subscription', () => {
    const subscription: { listener?: (view: MonitorView) => void } = {}
    const disposeResults = vi.fn()
    const monitor = {
      subscribeViews: vi.fn((next: (view: MonitorView) => void) => {
        subscription.listener = next
        return disposeResults
      }),
      getCurrentView: vi.fn(() => view),
    }
    const windows = { sendToRenderer: vi.fn().mockReturnValue(true) }
    const dispose = registerMonitorIpc({
      windows,
      monitor,
      logger: { info: vi.fn() },
    } as never)

    subscription.listener?.(view)
    expect(windows.sendToRenderer).toHaveBeenCalledWith(
      'main',
      MONITOR_IPC_CHANNELS.viewChanged,
      view,
    )

    dispose()
    expect(disposeResults).toHaveBeenCalledOnce()
  })
})

describe('monitor IPC search mode', () => {
  const sender = { senderFrame: { url: 'file:///app/index.html' }, sender: {} }
  const grand = { tag: '#2PRCRPQL', title: 'Grand Challenge' }
  function register(deckModes: Record<string, unknown>, local = { deckMode: 'pol' }) {
    const monitor = {
      subscribeViews: vi.fn(() => () => undefined),
      getPreferences: vi.fn().mockResolvedValue(local),
      updatePreferences: vi.fn((next: unknown) => Promise.resolve(next)),
    }
    registerMonitorIpc({
      windows: { assertSender: vi.fn() },
      logger: { info: vi.fn() },
      monitor,
      deckModes,
    } as never)
    const handler = (channel: string) => {
      const found = electron.handlers.get(channel)
      if (found === undefined) throw new Error(`Missing ${channel} handler`)
      return found
    }
    return { monitor, handler }
  }

  it('saves the mode on the server before keeping it locally', async () => {
    const save = vi.fn().mockResolvedValue({ deckMode: 'challenge', event: grand })
    const { monitor, handler } = register({ save })
    await expect(
      handler(MONITOR_IPC_CHANNELS.updatePreferences)(sender, {
        deckMode: 'challenge',
        event: grand,
      }),
    ).resolves.toEqual({ deckMode: 'challenge', event: grand })
    expect(save).toHaveBeenCalledWith({ deckMode: 'challenge', event: grand })
    expect(monitor.updatePreferences).toHaveBeenCalledWith({
      deckMode: 'challenge',
      event: grand,
    })
  })

  it('keeps the local mode when the server refuses it', async () => {
    const save = vi.fn().mockRejectedValue(new Error('gone'))
    const { monitor, handler } = register({ save })
    await expect(
      handler(MONITOR_IPC_CHANNELS.updatePreferences)(sender, { deckMode: 'gt' }),
    ).rejects.toThrow('gone')
    expect(monitor.updatePreferences).not.toHaveBeenCalled()
  })

  it('takes the mode picked on the site and lists the live events', async () => {
    const events = [
      {
        tag: grand.tag,
        title: grand.title,
        description: null,
        kind: 'challenge',
        max_wins: 12,
        max_losses: 3,
        first_seen_at: null,
        active: true,
      },
    ]
    const { monitor, handler } = register({
      listEvents: vi.fn().mockResolvedValue(events),
      read: vi.fn().mockResolvedValue({ deckMode: 'challenge', event: grand }),
    })
    await expect(
      handler(MONITOR_IPC_CHANNELS.getModeOptions)(sender, {}),
    ).resolves.toEqual({
      events,
      preferences: { deckMode: 'challenge', event: grand },
    })
    expect(monitor.updatePreferences).toHaveBeenCalledWith({
      deckMode: 'challenge',
      event: grand,
    })
  })

  it('keeps the local mode when the server cannot be read', async () => {
    const { monitor, handler } = register(
      {
        listEvents: vi.fn().mockResolvedValue(null),
        read: vi.fn().mockResolvedValue(null),
      },
      { deckMode: 'gt' },
    )
    await expect(
      handler(MONITOR_IPC_CHANNELS.getModeOptions)(sender, {}),
    ).resolves.toEqual({
      events: null,
      preferences: { deckMode: 'gt' },
    })
    expect(monitor.updatePreferences).not.toHaveBeenCalled()
  })
})
