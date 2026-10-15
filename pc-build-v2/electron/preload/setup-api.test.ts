import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { invoke: electron.invoke } }))

import { SETUP_IPC_CHANNELS } from '../../shared/contracts/capture-ipc'
import { SetupSessionViewSchema } from '../../shared/models/setup'
import { setupApi } from './setup-api'

const sessionId = '00000000-0000-4000-8000-000000000001'
const command = { sessionId, generation: 1 }
const view = SetupSessionViewSchema.parse({
  ...command,
  state: 'DETECTING',
  source: { kind: 'display', label: 'Display', displayId: 'display-1' },
  frameSize: null,
  game: null,
  regionOrigins: null,
  triggerKind: null,
  regions: { trigger: null, nickname: null, topLeftEvidence: null },
  triggerProfile: null,
  error: null,
  detection: {
    status: 'running',
    phase: 'locating_game',
    startedAt: '2026-10-13T12:00:00.000Z',
    deadlineAt: '2026-10-13T12:01:00.000Z',
    game: null,
    failure: null,
    frameAvailable: false,
    nameCheck: { status: 'pending', text: null },
  },
})

beforeEach(() => electron.invoke.mockReset())

describe('automatic setup preload', () => {
  it.each(['retryDetection', 'switchToManual'] as const)(
    'validates and forwards %s with generation fencing',
    async (method) => {
      electron.invoke.mockResolvedValue(
        method === 'retryDetection' ? { ok: true, session: view } : view,
      )
      await expect(setupApi[method](command)).resolves.toEqual(view)
      expect(electron.invoke).toHaveBeenCalledWith(SETUP_IPC_CHANNELS[method], command)
      electron.invoke.mockClear()
      await expect(
        setupApi[method]({ ...command, extra: true } as never),
      ).rejects.toThrow()
      expect(electron.invoke).not.toHaveBeenCalled()
    },
  )

  it.each(['SETUP_SOURCE_LOST', 'SETUP_CAPTURE_UNAVAILABLE'])(
    'preserves retry command error code %s across IPC',
    async (code) => {
      electron.invoke.mockResolvedValue({
        ok: false,
        error: { code, message: 'Не получилось настроить автоматически' },
      })
      await expect(setupApi.retryDetection(command)).rejects.toMatchObject({ code })
    },
  )

  it('accepts null and validates bounded JPEG preview bytes', async () => {
    electron.invoke.mockResolvedValue(null)
    await expect(setupApi.getDetectionPreview({ sessionId })).resolves.toBeNull()
    expect(electron.invoke).toHaveBeenCalledWith(SETUP_IPC_CHANNELS.getDetectionPreview, {
      sessionId,
    })
    const preview = {
      width: 360,
      height: 640,
      mimeType: 'image/jpeg',
      byteLength: 3,
      bytes: new Uint8Array([1, 2, 3]),
    }
    electron.invoke.mockResolvedValue(preview)
    await expect(setupApi.getDetectionPreview({ sessionId })).resolves.toEqual(preview)
    electron.invoke.mockResolvedValue({ ...preview, byteLength: 4 })
    await expect(setupApi.getDetectionPreview({ sessionId })).rejects.toThrow()
    electron.invoke.mockResolvedValue({ ...preview, width: 641 })
    await expect(setupApi.getDetectionPreview({ sessionId })).rejects.toThrow()
  })

  it('exposes no result-zone setup and rejects result-zone session views', () => {
    expect(setupApi).not.toHaveProperty('startResult')
    expect(Object.values(SETUP_IPC_CHANNELS)).not.toContain('setup:start-result')
    expect(
      SetupSessionViewSchema.safeParse({ ...view, kind: 'predictionResult' }).success,
    ).toBe(false)
    expect(
      SetupSessionViewSchema.safeParse({
        ...view,
        regions: { ...view.regions, resultTrigger: null },
      }).success,
    ).toBe(false)
  })
})
