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
describe('M6 profile command envelope', () => {
  it.each([
    ['activateProfile', 'activate'],
    ['renameProfile', 'rename'],
    ['duplicateProfile', 'duplicate'],
    ['deleteProfile', 'delete'],
    ['rebindProfile', 'rebind'],
  ] as const)(
    '#4 preserves an allowlisted code without exposing a message for %s',
    async (channel, method) => {
      const invoke = vi
        .fn()
        .mockRejectedValue(
          new ApplicationError(
            'CAPTURE_PROFILE_STALE',
            'a completely reworded private message',
          ),
        )
      const event = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }
      registerCaptureIpc({
        windows: { assertSender: vi.fn() },
        profiles: { [method]: invoke },
        preparations: {
          freeze: vi
            .fn()
            .mockResolvedValue({ source: { preference: {} }, frame: { size: {} } }),
        },
        logger: { info: vi.fn(), warn: vi.fn() },
      } as never)
      const payload = {
        profileId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
        ...(channel === 'renameProfile' || channel === 'duplicateProfile'
          ? { profileName: 'New' }
          : {}),
        ...(channel === 'rebindProfile'
          ? { preparationId: preparation.preparationId }
          : {}),
      }
      await expect(
        registeredHandler(MAIN_CAPTURE_IPC_CHANNELS[channel])(event, payload),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'CAPTURE_PROFILE_STALE' },
      })
      invoke.mockRejectedValueOnce(
        new ApplicationError('PRIVATE_UNALLOWLISTED', 'private'),
      )
      await expect(
        registeredHandler(MAIN_CAPTURE_IPC_CHANNELS[channel])(event, payload),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'UNKNOWN' },
      })
    },
  )
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
    game: null,
    triggerKind: null,
    regionOrigins: null,
    regions: { trigger: null, nickname: null, topLeftEvidence: null },
    triggerProfile: null,
    error: null,
  })
  const command = { sessionId, generation: 1 }
  const event = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }
  function setupHarness() {
    const windows = { assertSender: vi.fn(), close: vi.fn() }
    const setup = {
      start: vi.fn().mockResolvedValue(view),
      startAuto: vi.fn().mockResolvedValue(view),
      retryDetection: vi.fn().mockReturnValue(view),
      switchToManual: vi.fn().mockResolvedValue(view),
      getDetectionPreview: vi.fn().mockReturnValue(null),
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
      takeLive: vi.fn().mockResolvedValue({
        source: { selector: { kind: 'window', windowHwnd: '10' }, preference: source },
        capture: { stop: vi.fn().mockResolvedValue(undefined) },
      }),
      freeze: vi.fn().mockResolvedValue({
        source: { selector: { kind: 'window', windowHwnd: '10' }, preference: source },
        frame: {
          size: { width: 100, height: 100 },
          png: Buffer.from('png'),
          game: {
            rect: { x: 20, y: 0, width: 56, height: 100 },
            aspect: 0.56,
            chrome: {
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              topEdges: null,
              bottomEdges: null,
              leftEdges: null,
              rightEdges: null,
            },
            frames: 8,
          },
        },
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
                  region: 'nickname',
                  rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
                }
              : name === 'getDetectionPreview'
                ? { sessionId }
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
    const result = await registeredHandler(MAIN_CAPTURE_IPC_CHANNELS.startSetup)(event, {
      mode: 'manual',
      preparationId: preparation.preparationId,
      profileId,
      profileName: 'Profile',
      expectedRevision: 2,
    })
    expect(result).toEqual(view)
    expect(test.preparations.freeze).toHaveBeenCalledWith(preparation.preparationId)
    expect(test.setup.start).toHaveBeenCalledWith(
      { kind: 'window', windowHwnd: '10' },
      source,
      'capture',
      expect.objectContaining({
        game: {
          rect: { x: 20, y: 0, width: 56, height: 100 },
          aspect: 0.56,
          frames: 8,
          chrome: {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            topEdges: null,
            bottomEdges: null,
            leftEdges: null,
            rightEdges: null,
          },
        },
      }),
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
  it('transfers live ownership to auto setup without freezing', async () => {
    const test = setupHarness()
    await registeredHandler(MAIN_CAPTURE_IPC_CHANNELS.startSetup)(event, {
      mode: 'auto',
      preparationId: preparation.preparationId,
      profileId,
      profileName: 'Profile',
      expectedRevision: 2,
    })
    expect(test.preparations.takeLive).toHaveBeenCalledWith(preparation.preparationId)
    expect(test.preparations.freeze).not.toHaveBeenCalled()
    const live = (await test.preparations.takeLive.mock.results[0]?.value) as {
      capture: { stop: () => Promise<void> }
    }
    expect(test.setup.startAuto).toHaveBeenCalledWith(
      { kind: 'window', windowHwnd: '10' },
      source,
      live.capture,
      { profileId, profileName: 'Profile', expectedRevision: 2 },
    )
  })

  it('stops the transferred capture if auto session creation is rejected', async () => {
    const test = setupHarness()
    const stop = vi.fn().mockResolvedValue(undefined)
    test.preparations.takeLive.mockResolvedValue({
      source: { selector: { kind: 'window', windowHwnd: '10' }, preference: source },
      capture: { stop },
    })
    test.setup.startAuto.mockRejectedValue(new Error('SETUP_ALREADY_ACTIVE'))
    await expect(
      registeredHandler(MAIN_CAPTURE_IPC_CHANNELS.startSetup)(event, {
        mode: 'auto',
        preparationId: preparation.preparationId,
        profileId,
        profileName: 'Profile',
        expectedRevision: 2,
      }),
    ).rejects.toThrow('SETUP_ALREADY_ACTIVE')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'invalid'])(
    'rejects mode %s before consuming the preparation',
    async (mode) => {
      const test = setupHarness()
      const payload = {
        preparationId: preparation.preparationId,
        profileId,
        profileName: 'Profile',
        expectedRevision: 2,
        ...(mode === undefined ? {} : { mode }),
      }
      await expect(
        registeredHandler(MAIN_CAPTURE_IPC_CHANNELS.startSetup)(event, payload),
      ).rejects.toThrow()
      expect(test.preparations.freeze).not.toHaveBeenCalled()
      expect(test.setup.start).not.toHaveBeenCalled()
    },
  )
})
