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

import { UPDATE_IPC_CHANNELS } from '../../../shared/contracts/update'
import { registerUpdateIpc } from './register-update-ipc'

const updateView = {
  state: 'IDLE',
  currentVersion: '1.0.0',
  availableVersion: null,
  critical: false,
  releaseNotes: [],
  progress: null,
  error: null,
} as const

beforeEach(() => electron.handlers.clear())

describe('update IPC boundary', () => {
  it('authorizes only the registered main or auth window', () => {
    const assertSender = vi.fn()
    registerUpdateIpc({
      windows: { assertSender },
      logger: { info: vi.fn() },
      updater: { getView: vi.fn(() => updateView) },
    } as never)
    const handler = electron.handlers.get(UPDATE_IPC_CHANNELS.getView)
    if (handler === undefined) throw new Error('Update handler was not registered')
    const sender = { id: 7, getURL: () => 'file:///app/auth.html' }

    expect(
      handler({ sender, senderFrame: { url: 'file:///app/auth.html' } }, {}),
    ).toEqual(updateView)
    expect(assertSender).toHaveBeenCalledWith(sender, 'file:///app/auth.html', [
      'main',
      'auth',
    ])
  })

  it('does not invoke updater methods after sender verification rejects', async () => {
    const check = vi.fn()
    registerUpdateIpc({
      windows: {
        assertSender: vi.fn(() => {
          throw new Error('rejected')
        }),
      },
      logger: { info: vi.fn() },
      updater: { check },
    } as never)
    const handler = electron.handlers.get(UPDATE_IPC_CHANNELS.check)
    if (handler === undefined) throw new Error('Update handler was not registered')

    await expect(
      handler(
        {
          sender: { id: 9, getURL: () => 'https://attacker.example' },
          senderFrame: { url: 'https://attacker.example' },
        },
        {},
      ),
    ).rejects.toThrow('rejected')
    expect(check).not.toHaveBeenCalled()
  })
})
