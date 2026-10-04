import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      electron.handlers.set(channel, handler)
    },
    removeHandler: vi.fn(),
  },
}))

import { AUTH_IPC_CHANNELS } from '../../../shared/contracts/auth-ipc'
import { registerAuthNetworkIpc } from './register-auth-network-ipc'

const view = { state: 'UNAUTHENTICATED', user: null, error: null }
const payload = {
  email: 'fixture@example.com',
  username: 'fixture',
  password: 'test-password',
  inviteKey: ' test_key-123 ',
}
const event = { sender: { id: 7 }, senderFrame: { url: 'file:///app/auth.html' } }

beforeEach(() => electron.handlers.clear())

function registeredHandler(channel: string) {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error('Expected a registered IPC handler')
  return handler
}

function setup(assertSender = vi.fn()) {
  const auth = {
    register: vi.fn().mockResolvedValue(view),
    resetLogin: vi.fn(() => view),
  }
  registerAuthNetworkIpc({
    windows: { assertSender },
    logger: { info: vi.fn() },
    auth,
    realtime: {},
  } as never)
  return { auth, assertSender }
}

describe('auth IPC boundary', () => {
  it('validates registration in main and forwards the trimmed key', async () => {
    const { auth, assertSender } = setup()
    const handler = registeredHandler(AUTH_IPC_CHANNELS.register)
    await expect(handler(event, payload)).resolves.toEqual(view)
    expect(auth.register).toHaveBeenCalledWith(
      'fixture@example.com',
      'fixture',
      'test-password',
      'test_key-123',
    )
    expect(assertSender).toHaveBeenCalledWith(event.sender, event.senderFrame.url, 'auth')
    for (const invalid of [
      { ...payload, inviteKey: undefined },
      { ...payload, inviteKey: 'bad' },
      { ...payload, hwid: 'renderer-device' },
    ]) {
      await expect(handler(event, invalid)).rejects.toThrow()
    }
    expect(auth.register).toHaveBeenCalledOnce()
  })

  it('rejects untrusted senders before registration', async () => {
    const { auth } = setup(
      vi.fn(() => {
        throw new Error('rejected')
      }),
    )
    await expect(
      registeredHandler(AUTH_IPC_CHANNELS.register)(event, payload),
    ).rejects.toThrow('rejected')
    expect(auth.register).not.toHaveBeenCalled()
  })

  it('authorizes reset-login and rejects unexpected payload fields', () => {
    const { auth, assertSender } = setup()
    const handler = registeredHandler(AUTH_IPC_CHANNELS.resetLogin)
    expect(handler(event, {})).toEqual(view)
    expect(auth.resetLogin).toHaveBeenCalledOnce()
    expect(assertSender).toHaveBeenCalledWith(event.sender, event.senderFrame.url, 'auth')
    expect(() => handler(event, { token: 'not-accepted' })).toThrow()
    expect(auth.resetLogin).toHaveBeenCalledOnce()
  })
})
