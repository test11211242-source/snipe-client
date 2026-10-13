import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, api: unknown) => {
      electron.exposed.set(name, api)
    }),
  },
  ipcRenderer: { invoke: electron.invoke },
}))

import { MAIN_CAPTURE_IPC_CHANNELS } from '../../shared/contracts/capture-ipc'
import { SetupSessionViewSchema } from '../../shared/models/setup'
import './main'

function startCaptureSetup(payload: unknown): Promise<unknown> {
  const api = electron.exposed.get('crTools') as {
    startCaptureSetup: (raw: unknown) => Promise<unknown>
  }
  return api.startCaptureSetup(payload)
}

const payload = {
  preparationId: '00000000-0000-4000-8000-000000000020',
  profileId: null,
  profileName: 'Manual',
  expectedRevision: 0,
}
const view = SetupSessionViewSchema.parse({
  sessionId: '00000000-0000-4000-8000-000000000001',
  generation: 1,
  state: 'SELECTING',
  source: {
    kind: 'window',
    label: 'Game',
    titleHint: 'Game',
    executableLabel: null,
  },
  frameSize: { width: 100, height: 100 },
  game: {
    viewport: { x: 0.2, y: 0, width: 0.56, height: 1 },
    aspect: 0.56,
    source: 'freeze',
  },
  triggerKind: null,
  regionOrigins: null,
  regions: { trigger: null, nickname: null, topLeftEvidence: null },
  triggerProfile: null,
  error: null,
})

beforeEach(() => {
  electron.invoke.mockReset()
})

describe('manual capture setup preload boundary', () => {
  it('forwards explicit manual mode and validates the returned session', async () => {
    electron.invoke.mockResolvedValue(view)
    await expect(startCaptureSetup({ ...payload, mode: 'manual' })).resolves.toEqual(view)
    expect(electron.invoke).toHaveBeenCalledWith(MAIN_CAPTURE_IPC_CHANNELS.startSetup, {
      ...payload,
      mode: 'manual',
    })
  })

  it.each([undefined, 'auto'])('rejects mode %s without invoking main', async (mode) => {
    await expect(
      startCaptureSetup({
        ...payload,
        ...(mode === undefined ? {} : { mode }),
      }),
    ).rejects.toThrow()
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('rejects extra request fields without invoking main', async () => {
    await expect(
      startCaptureSetup({ ...payload, mode: 'manual', windowHwnd: '10' }),
    ).rejects.toThrow()
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it.each(['game', 'triggerKind', 'regionOrigins'] as const)(
    'rejects a response missing the required nullable %s field',
    async (field) => {
      const incomplete: Record<string, unknown> = Object.fromEntries(
        Object.entries(view).filter(([key]) => key !== field),
      )
      electron.invoke.mockResolvedValue(incomplete)
      await expect(startCaptureSetup({ ...payload, mode: 'manual' })).rejects.toThrow()
    },
  )
})
