import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  StreamerCommandResultSchema,
  type StreamerCommand,
} from '../../../shared/contracts/streamer-ipc'
import { TITLE_BUILDER_CHANNELS } from '../../../shared/contracts/title-builder'
import { StreamerService } from '../services/streamer-service'
import {
  DEFAULT_TITLE_SETTINGS,
  DEFAULT_OVERLAY_SETTINGS,
} from '../services/streamer-adapters'
import { DEFAULT_PREDICTION_SETTINGS } from '../../../shared/models/streamer'
import { registerStreamerIpc } from './register-streamer-ipc'

const event = { sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }
const view = new StreamerService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
).getView()
const REQUEST_ID = '6f1f7c2e-8a3b-4c7d-9e2f-0a1b2c3d4e5f'
const commands: StreamerCommand[] = [
  { action: 'twitch.connect' },
  { action: 'twitch.disconnect', confirmed: true },
  { action: 'predictions.settings.save', settings: DEFAULT_PREDICTION_SETTINGS },
  ...(['win', 'loss', 'not_ranked'] as const).map((outcome) => ({
    action: 'predictions.battle' as const,
    predictionId: 1,
    outcome,
    requestId: REQUEST_ID,
  })),
  { action: 'predictions.cancel', predictionId: 1, confirmed: true },
  ...(['title.save', 'title.preview', 'title.apply'] as const).map((action) => ({
    action,
    settings: DEFAULT_TITLE_SETTINGS,
  })),
  { action: 'title.enabled', enabled: true },
  { action: 'title.paused', paused: true },
  ...(['title.reset', 'title.undo', 'title.restore'] as const).map((action) => ({
    action,
    confirmed: true as const,
  })),
  { action: 'chat.toggle', enabled: true },
  { action: 'widget.enabled', enabled: true },
  { action: 'widget.settings', settings: DEFAULT_OVERLAY_SETTINGS },
  { action: 'widget.resetToken', confirmed: true },
  { action: 'widget.copy', kind: 'opponent' },
  { action: 'accounts.add', tag: '#P0Y', alias: 'Alias' },
  { action: 'accounts.remove', tag: '#P0Y' },
  { action: 'accounts.reenable', tag: '#P0Y' },
]
function registeredHandler(channel: string) {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`Missing handler ${channel}`)
  return handler
}

function harness() {
  const windows = { assertSender: vi.fn() }
  const response = {
    ok: true,
    view,
    preview: null,
    warnings: [],
    titleApplication: 'not_requested',
  }
  const streamer = {
    execute: vi.fn().mockResolvedValue(response),
    getReadiness: vi.fn().mockResolvedValue({
      twitchConnected: true,
      accountsCount: 1,
      monitoring: true,
      captureConfigured: true,
      predictionProfileReady: false,
      activeProfileId: '00000000-0000-4000-8000-000000000001',
    }),
  }
  const dispose = registerStreamerIpc({
    windows,
    streamer,
    logger: { info: vi.fn() },
  } as never)
  return { windows, streamer, response, dispose }
}
beforeEach(() => handlers.clear())
describe('streamer mutation capability', () => {
  it.each(commands)('validates and fences $action', async (command) => {
    const test = harness()
    const handle = registeredHandler(STREAMER_IPC_CHANNELS.command)
    expect(StreamerCommandResultSchema.parse(await handle(event, command))).toEqual(
      test.response,
    )
    expect(test.windows.assertSender).toHaveBeenCalledWith(
      event.sender,
      event.senderFrame.url,
      'main',
    )
    expect(test.streamer.execute).toHaveBeenCalledWith(command)
    expect(await handle(event, { ...command, arbitrary: true })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    test.windows.assertSender.mockImplementation(() => {
      throw new Error('IPC_SENDER_REJECTED')
    })
    await expect(handle(event, command)).rejects.toThrow('IPC_SENDER_REJECTED')
  })
  it.each([
    'ACCOUNT_TAG_INVALID',
    'ACCOUNT_NOT_FOUND',
    'ACCOUNT_LIMIT_REACHED',
    'CLASH_API_UNAVAILABLE',
    'ACCOUNT_SAVE_UNAVAILABLE',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'VALIDATION_FAILED',
  ])('preserves allowlisted %s through JSON', async (code) => {
    const test = harness()
    const response = { ok: false, error: { code, detail: 'Safe domain detail' } }
    test.streamer.execute.mockResolvedValue(response)
    expect(
      StreamerCommandResultSchema.parse(
        JSON.parse(
          JSON.stringify(
            await registeredHandler(STREAMER_IPC_CHANNELS.command)(event, commands[0]),
          ),
        ),
      ),
    ).toEqual(response)
    test.streamer.execute.mockResolvedValue({
      ok: false,
      error: { code: 'UNTRUSTED_CODE', detail: 'raw' },
    })
    await expect(
      registeredHandler(STREAMER_IPC_CHANNELS.command)(event, commands[0]),
    ).rejects.toThrow()
  })
  it('requires explicit destructive confirmation', async () => {
    harness()
    for (const action of [
      'twitch.disconnect',
      'title.reset',
      'title.undo',
      'title.restore',
      'widget.resetToken',
    ])
      expect(
        await registeredHandler(STREAMER_IPC_CHANNELS.command)(event, {
          action,
          confirmed: false,
        }),
      ).toMatchObject({ ok: false })
  })
  it('requires one UUID request ID and a known outcome for a manual battle', async () => {
    const test = harness()
    const handle = registeredHandler(STREAMER_IPC_CHANNELS.command)
    const valid = {
      action: 'predictions.battle',
      predictionId: 1,
      outcome: 'not_ranked',
      requestId: REQUEST_ID,
    }
    const { requestId: omitted, ...withoutRequestId } = valid
    void omitted
    for (const invalid of [
      withoutRequestId,
      { ...valid, requestId: null },
      { ...valid, requestId: '' },
      { ...valid, requestId: 'not-a-uuid' },
      { ...valid, requestId: 42 },
      { ...valid, outcome: 'draw' },
      { ...valid, outcome: 'skip' },
    ])
      expect(await handle(event, invalid)).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      })
    expect(test.streamer.execute).not.toHaveBeenCalled()
    await handle(event, valid)
    expect(test.streamer.execute).toHaveBeenCalledExactlyOnceWith(valid)
  })
  it('fences readiness and both compiler directions to main', async () => {
    const test = harness()
    expect(
      await registeredHandler(STREAMER_IPC_CHANNELS.readiness)(event, {}),
    ).toMatchObject({ accountsCount: 1, predictionProfileReady: false })
    await expect(
      registeredHandler(STREAMER_IPC_CHANNELS.readiness)(event, { extra: true }),
    ).rejects.toThrow()
    expect(
      registeredHandler(TITLE_BUILDER_CHANNELS.compile)(event, {
        settings: DEFAULT_TITLE_SETTINGS,
        builder: { mode: 'preset', preset: 'short' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      registeredHandler(TITLE_BUILDER_CHANNELS.compile)(event, {
        settings: DEFAULT_TITLE_SETTINGS,
        builder: { mode: 'chips', chips: [{ kind: 'account' }, { kind: 'best' }] },
      }),
    ).toMatchObject({ ok: false, code: 'TITLE_ACCOUNT_SELECTION_CONFLICT' })
    expect(
      registeredHandler(TITLE_BUILDER_CHANNELS.compile)(event, { garbage: true }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(
      registeredHandler(TITLE_BUILDER_CHANNELS.decompile)(event, DEFAULT_TITLE_SETTINGS),
    ).toBeDefined()
    for (const channel of [
      STREAMER_IPC_CHANNELS.readiness,
      ...Object.values(TITLE_BUILDER_CHANNELS),
    ]) {
      test.windows.assertSender.mockImplementation(() => {
        throw new Error('IPC_SENDER_REJECTED')
      })
      await expect(
        Promise.resolve().then(() => registeredHandler(channel)(event, {})),
      ).rejects.toThrow('IPC_SENDER_REJECTED')
      test.windows.assertSender.mockReset()
    }
    test.dispose()
    expect(handlers.size).toBe(0)
  })
})
