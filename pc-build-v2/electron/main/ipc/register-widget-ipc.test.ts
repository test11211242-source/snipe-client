import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  copyTag: vi.fn(),
}))

vi.mock('electron', () => ({
  clipboard: { writeText: electron.copyTag },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        electron.handlers.set(channel, handler)
      },
    ),
    removeHandler: vi.fn(),
  },
}))
import { CLIPBOARD_CHANNELS } from '../../../shared/contracts/clipboard'

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
  const images = {
    getCardAsset: vi
      .fn()
      .mockResolvedValue({ kind: 'available', dataUrl: 'data:image/png;base64,AA==' }),
  }
  registerWidgetIpc({
    windows,
    widget,
    images,
    logger: { info: vi.fn() },
  } as never)
  const event = {
    senderFrame: { url: 'file:///app/widget.html' },
    sender: { id: 7, getURL: () => 'file:///app/widget.html' },
  }
  return { event, widget, windows, images }
}

beforeEach(() => {
  electron.handlers.clear()
  electron.copyTag.mockClear()
})

describe('widget IPC boundary', () => {
  it('bounds dynamic content height on both narrow settings capabilities', async () => {
    const test = harness()
    test.widget.updateSettings.mockResolvedValue(DEFAULT_WIDGET_SETTINGS)
    for (const [channel, kind] of [
      [MAIN_WIDGET_IPC_CHANNELS.updateSettings, 'main'],
      [WIDGET_IPC_CHANNELS.updateSettings, 'widget'],
    ] as const) {
      const handler = electron.handlers.get(channel)
      if (handler === undefined) throw new Error('Missing height handler')
      await expect(handler(test.event, { contentHeight: 120 })).resolves.toEqual(
        DEFAULT_WIDGET_SETTINGS,
      )
      expect(test.windows.assertSender).toHaveBeenLastCalledWith(
        test.event.sender,
        test.event.senderFrame.url,
        kind,
      )
      await expect(handler(test.event, { contentHeight: 721 })).rejects.toThrow()
      await expect(handler(test.event, { contentHeight: 79 })).rejects.toThrow()
      await expect(
        handler(test.event, { contentHeight: 120, bounds: {} }),
      ).rejects.toThrow()
    }
    expect(test.widget.updateSettings).toHaveBeenCalledTimes(2)
  })

  it('copies a canonical widget player tag only after its sender and payload pass', () => {
    const test = harness()
    const handler = electron.handlers.get(CLIPBOARD_CHANNELS.widgetCopyTag)
    if (handler === undefined) throw new Error('Missing widget tag copy handler')
    expect(handler(test.event, { tag: 'jcu' })).toEqual({ copied: true })
    expect(electron.copyTag).toHaveBeenCalledWith('#JCU')
    expect(test.windows.assertSender).toHaveBeenCalledWith(
      test.event.sender,
      test.event.senderFrame.url,
      'widget',
    )
    expect(() => handler(test.event, { tag: 'BAD' })).toThrow()
    expect(() => handler(test.event, { tag: 'JCU', text: 'anything' })).toThrow()
    test.windows.assertSender.mockImplementation(() => {
      throw new Error('IPC_SENDER_REJECTED')
    })
    expect(() => handler(test.event, { tag: 'JCU' })).toThrow('IPC_SENDER_REJECTED')
    expect(electron.copyTag).toHaveBeenCalledOnce()
  })

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

  it('serves card art to the registered main window only, by strict result reference', async () => {
    const test = harness()
    const handler = electron.handlers.get(MAIN_WIDGET_IPC_CHANNELS.getCardAsset)
    if (handler === undefined) throw new Error('Main card asset handler missing')
    const request = {
      resultId: '39d970c1-fc4f-4bea-a767-8f108d3b8739',
      deckIndex: 1,
      cardIndex: 7,
    }
    const mainEvent = {
      sender: { id: 1 },
      senderFrame: { url: 'file:///app/index.html' },
    }
    const registry: Record<number, { kind: string; url: string }> = {
      1: { kind: 'main', url: 'file:///app/index.html' },
      2: { kind: 'auth', url: 'file:///app/auth.html' },
      7: { kind: 'widget', url: 'file:///app/widget.html' },
    }
    test.windows.assertSender.mockImplementation(
      (sender: { id: number }, url: string, kind: string) => {
        const registered = registry[sender.id]
        if (registered?.kind !== kind || registered.url !== url)
          throw new Error('IPC_SENDER_REJECTED')
      },
    )

    await expect(handler(mainEvent, request)).resolves.toEqual({
      kind: 'available',
      dataUrl: 'data:image/png;base64,AA==',
    })
    expect(test.images.getCardAsset).toHaveBeenCalledWith(request)
    expect(test.windows.assertSender).toHaveBeenLastCalledWith(
      mainEvent.sender,
      'file:///app/index.html',
      'main',
    )

    for (const rejected of [
      { sender: { id: 2 }, senderFrame: { url: 'file:///app/auth.html' } },
      test.event,
      { sender: { id: 1 }, senderFrame: { url: 'https://example.com/index.html' } },
      { sender: { id: 99 }, senderFrame: { url: 'file:///app/index.html' } },
    ]) {
      await expect(handler(rejected, request)).rejects.toThrow('IPC_SENDER_REJECTED')
    }
    expect(test.images.getCardAsset).toHaveBeenCalledOnce()
  })

  it('rejects card asset requests that carry URLs, extra keys or out-of-range indexes', async () => {
    const test = harness()
    const handler = electron.handlers.get(MAIN_WIDGET_IPC_CHANNELS.getCardAsset)
    if (handler === undefined) throw new Error('Main card asset handler missing')
    const mainEvent = {
      sender: { id: 1 },
      senderFrame: { url: 'file:///app/index.html' },
    }
    const base = {
      resultId: '39d970c1-fc4f-4bea-a767-8f108d3b8739',
      deckIndex: 0,
      cardIndex: 0,
    }
    for (const payload of [
      {},
      { ...base, url: 'https://api-assets.clashroyale.com/card.png' },
      { ...base, resultId: 'not-a-uuid' },
      { ...base, deckIndex: 5 },
      { ...base, cardIndex: 8 },
      { ...base, cardIndex: -1 },
      { ...base, cardIndex: 1.5 },
    ]) {
      await expect(handler(mainEvent, payload)).rejects.toThrow()
    }
    expect(test.images.getCardAsset).not.toHaveBeenCalled()
  })
})
