import { describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, payload: unknown) => unknown>(),
)
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}))
import {
  STREAMER_IPC_CHANNELS,
  AccountMutationResultSchema,
} from '../../../shared/contracts/streamer-ipc'
import { registerStreamerIpc } from './register-streamer-ipc'

describe('account IPC result envelope', () => {
  it('returns allowlisted domain detail across IPC without custom Error serialization', async () => {
    const windows = { assertSender: vi.fn() }
    const response = {
      ok: false,
      error: { code: 'ACCOUNT_NOT_FOUND', detail: 'Clash Royale account was not found' },
    }
    const streamer = { addTitleAccount: vi.fn().mockResolvedValue(response) }
    registerStreamerIpc({
      windows,
      streamer,
      setup: {},
      logger: { info: vi.fn() },
    } as never)
    const add = handlers.get(STREAMER_IPC_CHANNELS.addTitleAccount)
    if (add === undefined) throw new Error('Missing account-add handler')
    const event = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }
    const result = await add(event, { tag: '#P0Y', alias: 'Alias' })
    expect(
      AccountMutationResultSchema.parse(JSON.parse(JSON.stringify(result)) as unknown),
    ).toEqual(response)
    expect(streamer.addTitleAccount).toHaveBeenCalledWith('#P0Y', 'Alias')
    expect(windows.assertSender).toHaveBeenCalledWith(
      event.sender,
      event.senderFrame.url,
      'main',
    )
    streamer.addTitleAccount.mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNTRUSTED_CODE', detail: 'raw' },
    })
    await expect(add(event, { tag: '#P0Y', alias: 'Alias' })).rejects.toThrow()
    await expect(
      add(event, { tag: '#P0Y', alias: 'Alias', arbitrary: true }),
    ).rejects.toThrow()
  })
})
