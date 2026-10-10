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

import {
  MAIN_CAPTURE_IPC_CHANNELS,
  SETUP_IPC_CHANNELS,
} from '../../../shared/contracts/capture-ipc'
import { SetupSessionViewSchema } from '../../../shared/models/setup'
import { ApplicationError } from '../../../shared/errors/application-error'
import { registerCaptureIpc } from './register-capture-ipc'

function registeredHandler(channel: string) {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`Missing handler ${channel}`)
  return handler
}

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

describe('main-window setup capability', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const profileId = '00000000-0000-4000-8000-000000000002'
  const source = {
    kind: 'window',
    label: 'Game',
    titleHint: 'Game',
    executableLabel: null,
  }
  const view = SetupSessionViewSchema.parse({
    sessionId,
    generation: 1,
    state: 'SELECTING',
    source,
    frameSize: { width: 100, height: 100 },
    regions: { trigger: null, normal: null, precise: null },
    triggerProfile: null,
    error: null,
  })
  const command = { sessionId, generation: 1 }
  const event = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }
  function setupHarness() {
    const windows = { assertSender: vi.fn(), close: vi.fn() }
    const setup = {
      start: vi.fn().mockResolvedValue(view),
      startPredictionResult: vi.fn().mockResolvedValue(view),
      getSession: vi.fn().mockReturnValue(view),
      getFrame: vi.fn().mockReturnValue({
        ...command,
        size: { width: 100, height: 100 },
        byteLength: 3,
        mimeType: 'image/png',
        bytes: new Uint8Array(3),
      }),
      setRegion: vi.fn().mockReturnValue(view),
      finish: vi.fn().mockResolvedValue(view),
      analyzeTrigger: vi.fn().mockResolvedValue(view),
      review: vi.fn().mockReturnValue(view),
      commit: vi.fn().mockResolvedValue(view),
      retrySync: vi.fn().mockResolvedValue(view),
      cancel: vi.fn().mockReturnValue(view),
      close: vi.fn().mockReturnValue(view),
    }
    const preparations = {
      freeze: vi.fn().mockResolvedValue({
        source: { selector: { kind: 'window', windowHwnd: '10' }, preference: source },
        frame: { size: { width: 100, height: 100 }, png: Buffer.from('png') },
      }),
    }
    const dispose = registerCaptureIpc({
      windows,
      setup,
      preparations,
      logger: { info: vi.fn() },
    } as never)
    return { windows, setup, preparations, dispose }
  }
  it.each(Object.entries(SETUP_IPC_CHANNELS))(
    'fences %s to main and validates payload',
    async (name, channel) => {
      const test = setupHarness()
      const payload =
        name === 'getSession'
          ? {}
          : name === 'startResult'
            ? { profileId, expectedRevision: 2 }
            : name === 'setRegion' || name === 'finish'
              ? {
                  ...command,
                  region: 'normal',
                  rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
                }
              : command
      const handler = registeredHandler(channel)
      await handler(event, payload)
      expect(test.windows.assertSender).toHaveBeenCalledWith(
        event.sender,
        event.senderFrame.url,
        'main',
      )
      await expect(
        Promise.resolve().then(() => handler(event, { ...payload, extra: true })),
      ).rejects.toThrow()
      test.windows.assertSender.mockImplementation(() => {
        throw new Error('IPC_SENDER_REJECTED')
      })
      await expect(Promise.resolve().then(() => handler(event, payload))).rejects.toThrow(
        'IPC_SENDER_REJECTED',
      )
      expect(test.windows.close).not.toHaveBeenCalled()
    },
  )
  it('freezes and starts capture in main without opening or closing another window', async () => {
    const test = setupHarness()
    await registeredHandler(MAIN_CAPTURE_IPC_CHANNELS.startSetup)(event, {
      preparationId: preparation.preparationId,
      profileId,
      profileName: 'Profile',
      expectedRevision: 2,
    })
    expect(test.setup.start).toHaveBeenCalledWith(
      expect.anything(),
      source,
      'capture',
      expect.anything(),
      { profileId, profileName: 'Profile', expectedRevision: 2 },
    )
    await registeredHandler(SETUP_IPC_CHANNELS.startResult)(event, {
      profileId,
      expectedRevision: 2,
    })
    expect(test.setup.startPredictionResult).toHaveBeenCalledWith(profileId, 2)
    expect(test.windows.close).not.toHaveBeenCalled()
    test.dispose()
  })
})
