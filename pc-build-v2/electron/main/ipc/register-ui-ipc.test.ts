import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowKind } from '../windows/window-coordinator'
const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, payload: unknown) => unknown>(),
)
const copy = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  clipboard: { writeText: copy },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}))
import { CLIPBOARD_CHANNELS } from '../../../shared/contracts/clipboard'
import { H2H_CHANNELS } from '../../../shared/contracts/h2h'
import { WINDOW_CHANNEL } from '../../../shared/contracts/window'
import { registerUiIpc } from './register-ui-ipc'
const requestId = '00000000-0000-4000-8000-000000000001'
const event = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }
function handler(channel: string) {
  const registered = handlers.get(channel)
  if (registered === undefined) throw new Error(`Missing handler ${channel}`)
  return registered
}
function harness() {
  let generation = 1
  let notifyAuth: (() => void) | undefined
  let notifyClose: ((kind: WindowKind) => void) | undefined
  const disposeAuth = vi.fn(),
    disposeClose = vi.fn()
  const windows = {
    assertSender: vi.fn(),
    mainWindowCommand: vi.fn().mockReturnValue({ maximized: false }),
    onWindowClosed: vi.fn((listener: (kind: WindowKind) => void) => {
      notifyClose = listener
      return disposeClose
    }),
  }
  const h2h = {
    lookup: vi.fn<(input: unknown) => Promise<unknown>>().mockResolvedValue({
      capability: 'unsupported',
      requestId,
      retryAt: null,
      code: 'H2H_UNSUPPORTED',
    }),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
  }
  const auth = {
    getContextGeneration: () => generation,
    subscribe: vi.fn((listener: () => void) => {
      notifyAuth = listener
      return disposeAuth
    }),
  }
  const dispose = registerUiIpc(windows as never, h2h as never, auth as never)
  return {
    windows,
    h2h,
    dispose,
    disposeAuth,
    disposeClose,
    notifyAuth: () => notifyAuth?.(),
    changeAuth: () => {
      ++generation
      notifyAuth?.()
    },
    notifyClose: (kind: WindowKind) => notifyClose?.(kind),
  }
}
beforeEach(() => {
  handlers.clear()
  copy.mockClear()
})
describe('main UI capabilities', () => {
  it.each(['get', 'minimize', 'maximize', 'restore', 'close'])(
    'exposes narrow native %s',
    (action) => {
      const test = harness()
      expect(handler(WINDOW_CHANNEL)(event, { action })).toEqual({ maximized: false })
      expect(test.windows.mainWindowCommand).toHaveBeenCalledWith(action)
      expect(test.windows.assertSender).toHaveBeenCalledWith(
        event.sender,
        event.senderFrame.url,
        'main',
      )
      expect(() => handler(WINDOW_CHANNEL)(event, { action, path: 'bad' })).toThrow()
    },
  )
  it.each([
    WINDOW_CHANNEL,
    CLIPBOARD_CHANNELS.mainCopyTag,
    ...Object.values(H2H_CHANNELS),
  ])('denies non-main sender for %s', async (channel) => {
    const test = harness()
    test.windows.assertSender.mockImplementation(() => {
      throw new Error('IPC_SENDER_REJECTED')
    })
    await expect(
      Promise.resolve().then(() => handler(channel)(event, {})),
    ).rejects.toThrow('IPC_SENDER_REJECTED')
    expect(test.windows.mainWindowCommand).not.toHaveBeenCalled()
    expect(test.h2h.lookup).not.toHaveBeenCalled()
    expect(test.h2h.cancel).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })
  it('copies only canonical player tags, never arbitrary text or URLs', () => {
    const test = harness()
    expect(handler(CLIPBOARD_CHANNELS.mainCopyTag)(event, { tag: ' jcu ' })).toEqual({
      copied: true,
    })
    expect(copy).toHaveBeenCalledWith('#JCU')
    expect(test.windows.assertSender).toHaveBeenCalledWith(
      event.sender,
      event.senderFrame.url,
      'main',
    )
    for (const payload of [
      { tag: 'BAD' },
      { tag: '#JCU', text: 'secret' },
      { tag: 'https://example.com' },
    ]) {
      expect(() => handler(CLIPBOARD_CHANNELS.mainCopyTag)(event, payload)).toThrow()
    }
    expect(copy).toHaveBeenCalledOnce()
  })
  it('validates and preserves H2H lookup/cancellation without exposing HTTP', async () => {
    const test = harness()
    expect(
      await handler(H2H_CHANNELS.lookup)(event, {
        requestId,
        opponentTag: 'jcu',
        recentLimit: 10,
      }),
    ).toMatchObject({ capability: 'unsupported' })
    expect(test.h2h.lookup).toHaveBeenCalledWith({
      requestId,
      opponentTag: '#JCU',
      recentLimit: 10,
    })
    await expect(
      handler(H2H_CHANNELS.lookup)(event, {
        requestId,
        opponentTag: 'BAD',
        recentLimit: 10,
      }),
    ).rejects.toThrow()
    handler(H2H_CHANNELS.cancel)(event, { requestId })
    expect(test.h2h.cancel).toHaveBeenCalledWith(requestId)
    expect(() => handler(H2H_CHANNELS.cancel)(event, { requestId, all: true })).toThrow()
  })
  it('cancels on auth generation/main close/disposal, not token refresh or overlay close', () => {
    const test = harness()
    test.notifyAuth()
    test.notifyClose('widget')
    expect(test.h2h.cancelAll).not.toHaveBeenCalled()
    test.changeAuth()
    test.notifyClose('main')
    test.dispose()
    expect(test.h2h.cancelAll).toHaveBeenCalledTimes(3)
    expect(test.disposeAuth).toHaveBeenCalledOnce()
    expect(test.disposeClose).toHaveBeenCalledOnce()
    expect(handlers.size).toBe(0)
  })
})
