import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: unknown, payload: unknown) => Promise<unknown>,
      ) => {
        electron.handlers.set(channel, handler)
      },
    ),
    removeHandler: vi.fn(),
  },
}))

import { MAIN_CAPTURE_IPC_CHANNELS } from '../../../shared/contracts/capture-ipc'
import { ApplicationError } from '../../../shared/errors/application-error'
import { registerCaptureIpc } from './register-capture-ipc'

const sourceKey = 'a'.repeat(32)
const revision = 'b'.repeat(32)
const preparation = {
  preparationId: '00000000-0000-4000-8000-000000000020',
  sourceKey,
  revision,
}

function harness() {
  const logger = { info: vi.fn(), warn: vi.fn() }
  const preparations = { prepare: vi.fn().mockResolvedValue(preparation) }
  registerCaptureIpc({
    windows: { assertSender: vi.fn() },
    logger,
    preparations,
  } as never)
  const handler = electron.handlers.get(MAIN_CAPTURE_IPC_CHANNELS.prepareSource)
  if (handler === undefined) throw new Error('Prepare-source handler was not registered')
  const event = {
    senderFrame: { url: 'file:///app/index.html' },
    sender: { getURL: () => 'file:///app/index.html' },
  }
  return { handler, event, logger, preparations }
}

beforeEach(() => {
  electron.handlers.clear()
})

describe('capture preparation IPC boundary', () => {
  it('returns a strict success envelope', async () => {
    const test = harness()

    await expect(test.handler(test.event, { sourceKey, revision })).resolves.toEqual({
      ok: true,
      preparation,
    })
  })

  it('preserves an expected public error without logging private internals', async () => {
    const test = harness()
    test.preparations.prepare.mockRejectedValue(
      new ApplicationError('CAPTURE_SOURCE_STALE', 'Refresh the source list'),
    )

    await expect(test.handler(test.event, { sourceKey, revision })).resolves.toEqual({
      ok: false,
      error: { code: 'CAPTURE_SOURCE_STALE', message: 'Refresh the source list' },
    })
    expect(test.logger.warn).not.toHaveBeenCalled()
  })

  it('redacts and logs an unexpected preparation failure', async () => {
    const test = harness()
    const internal = new Error('C:\\private\\runtime path')
    test.preparations.prepare.mockRejectedValue(internal)

    await expect(test.handler(test.event, { sourceKey, revision })).resolves.toEqual({
      ok: false,
      error: {
        code: 'CAPTURE_PREPARATION_FAILED',
        message: 'The selected source could not be prepared',
      },
    })
    expect(test.logger.warn).toHaveBeenCalledWith('Capture source preparation failed', {
      error: internal,
    })
  })
})
