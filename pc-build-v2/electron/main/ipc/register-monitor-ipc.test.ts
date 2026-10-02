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
import type { MonitorResult, MonitorView } from '../../../shared/models/monitor'
import { registerMonitorIpc } from './register-monitor-ipc'

const view: MonitorView = {
  state: 'READY',
  preferences: { searchMode: 'fast', deckMode: 'pol' },
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
        subscribeResults: vi.fn(() => () => undefined),
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
        subscribeResults: vi.fn(() => () => undefined),
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
    const subscription: { listener?: (result: MonitorResult) => void } = {}
    const disposeResults = vi.fn()
    const monitor = {
      subscribeResults: vi.fn((next: (result: MonitorResult) => void) => {
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

    subscription.listener?.({} as MonitorResult)
    expect(windows.sendToRenderer).toHaveBeenCalledWith(
      'main',
      MONITOR_IPC_CHANNELS.viewChanged,
      view,
    )

    dispose()
    expect(disposeResults).toHaveBeenCalledOnce()
  })
})
