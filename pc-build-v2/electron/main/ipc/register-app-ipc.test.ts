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
import { IPC_CHANNELS } from '../../../shared/contracts/app'
import { registerAppIpc } from './register-app-ipc'

describe('diagnostics IPC', () => {
  it('opens only the fixed sink folder for main and rejects renderer paths', async () => {
    const windows = { assertSender: vi.fn() }
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      openFolder: vi.fn().mockResolvedValue(true),
    }
    const dispose = registerAppIpc({
      windows,
      logger,
      settings: {},
      getSnapshot: vi.fn(),
    } as never)
    const event = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }
    const open = handlers.get(IPC_CHANNELS.openLogFolder)
    if (open === undefined) throw new Error('Missing open-log capability')
    await expect(open(event, {})).resolves.toEqual({ opened: true })
    expect(logger.openFolder).toHaveBeenCalledWith()
    expect(windows.assertSender).toHaveBeenCalledWith(
      event.sender,
      event.senderFrame.url,
      'main',
    )
    await expect(open(event, { path: 'C:/private' })).rejects.toThrow()
    expect(logger.openFolder).toHaveBeenCalledOnce()
    windows.assertSender.mockImplementation(() => {
      throw new Error('wrong sender')
    })
    await expect(open(event, {})).rejects.toThrow('wrong sender')
    windows.assertSender.mockReset()
    const report = handlers.get(IPC_CHANNELS.reportBootstrapFailure)
    if (report === undefined) throw new Error('Missing report capability')
    report(event, { capability: 'widget', code: 'IPC_FAILED' })
    expect(logger.warn).toHaveBeenCalledWith('Renderer bootstrap capability failed', {
      capability: 'widget',
      code: 'IPC_FAILED',
    })
    expect(() =>
      report(event, { capability: 'widget', code: 'IPC_FAILED', message: 'private' }),
    ).toThrow()
    dispose()
    expect(handlers.has(IPC_CHANNELS.openLogFolder)).toBe(false)
  })
})
