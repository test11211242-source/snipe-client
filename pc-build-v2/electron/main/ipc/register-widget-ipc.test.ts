import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        electron.handlers.set(channel, handler)
      },
    ),
    removeHandler: vi.fn(),
  },
}))

import {
  MAIN_WIDGET_IPC_CHANNELS,
  WIDGET_IPC_CHANNELS,
} from '../../../shared/contracts/widget-ipc'
import { DEFAULT_WIDGET_SETTINGS } from '../infrastructure/widget-settings-repository'
import { registerWidgetIpc } from './register-widget-ipc'

function harness() {
  const windows = {
    assertSender: vi.fn(),
    markWidgetRendererReady: vi.fn(),
  }
  const status = {
    settings: DEFAULT_WIDGET_SETTINGS,
    visible: false,
    hasResult: false,
  }
  const widget = {
    getStatus: vi.fn(() => status),
    show: vi.fn().mockResolvedValue(status),
    toggle: vi.fn().mockResolvedValue(status),
    updateSettings: vi.fn().mockImplementation((patch) =>
      Promise.resolve({
        ...DEFAULT_WIDGET_SETTINGS,
        ...patch,
      }),
    ),
    getView: vi.fn(() => ({
      settings: DEFAULT_WIDGET_SETTINGS,
      visible: false,
      result: null,
    })),
    hide: vi.fn(() => status),
  }
  registerWidgetIpc({
    windows,
    widget,
    images: { getCardAsset: vi.fn() },
    logger: { info: vi.fn() },
  } as never)
  const event = {
    senderFrame: { url: 'file:///app/widget.html' },
    sender: { id: 7, getURL: () => 'file:///app/widget.html' },
  }
  return { event, widget, windows }
}

beforeEach(() => {
  electron.handlers.clear()
})

describe('widget IPC boundary', () => {
  it('accepts only strict user-setting patches and never renderer bounds', async () => {
    const test = harness()
    const handler = electron.handlers.get(MAIN_WIDGET_IPC_CHANNELS.updateSettings)
    if (handler === undefined)
      throw new Error('Widget settings handler was not registered')

    await expect(
      handler(test.event, { locked: true, opacity: 0.75 }),
    ).resolves.toMatchObject({
      locked: true,
      opacity: 0.75,
      bounds: DEFAULT_WIDGET_SETTINGS.bounds,
    })
    expect(test.widget.updateSettings).toHaveBeenCalledWith({
      locked: true,
      opacity: 0.75,
    })
    await expect(
      handler(test.event, {
        locked: false,
        bounds: { x: 10, y: 20, width: 500, height: 500 },
      }),
    ).rejects.toThrow()
    await expect(handler(test.event, {})).rejects.toThrow()
    expect(test.widget.updateSettings).toHaveBeenCalledTimes(1)
    expect(test.windows.assertSender).toHaveBeenCalledWith(
      test.event.sender,
      'file:///app/widget.html',
      'main',
    )
  })

  it('authenticates the narrow renderer-ready handshake before releasing input', () => {
    const test = harness()
    const handler = electron.handlers.get(WIDGET_IPC_CHANNELS.rendererReady)
    if (handler === undefined) throw new Error('Widget ready handler was not registered')

    expect(handler(test.event, {})).toBe(true)
    expect(test.windows.assertSender).toHaveBeenCalledWith(
      test.event.sender,
      'file:///app/widget.html',
      'widget',
    )
    expect(test.windows.markWidgetRendererReady).toHaveBeenCalledOnce()
    expect(() => handler(test.event, { ready: true })).toThrow()
    expect(test.windows.markWidgetRendererReady).toHaveBeenCalledOnce()
  })
})
