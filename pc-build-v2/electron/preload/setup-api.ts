import { ipcRenderer } from 'electron'
import {
  CaptureProfileCommandSchema,
  EmptyCapturePayloadSchema,
  SETUP_IPC_CHANNELS,
  SetRegionPayloadSchema,
  SetupCommandSchema,
  SetupFrameResultSchema,
  SetupSessionResultSchema,
} from '../../shared/contracts/capture-ipc'
import type { CrToolsSetupApi } from '../../shared/contracts/preload'

const command = (channel: string) => async (raw: unknown) =>
  SetupSessionResultSchema.parse(
    await ipcRenderer.invoke(channel, SetupCommandSchema.parse(raw)),
  )
export const setupApi: CrToolsSetupApi = Object.freeze<CrToolsSetupApi>({
  startResult: async (raw) =>
    SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(
        SETUP_IPC_CHANNELS.startResult,
        CaptureProfileCommandSchema.parse(raw),
      ),
    ),
  getSession: async () =>
    SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(
        SETUP_IPC_CHANNELS.getSession,
        EmptyCapturePayloadSchema.parse({}),
      ),
    ),
  getFrame: async (raw) =>
    SetupFrameResultSchema.parse(
      await ipcRenderer.invoke(
        SETUP_IPC_CHANNELS.getFrame,
        SetupCommandSchema.parse(raw),
      ),
    ),
  setRegion: async (raw) =>
    SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(
        SETUP_IPC_CHANNELS.setRegion,
        SetRegionPayloadSchema.parse(raw),
      ),
    ),
  finish: async (raw) =>
    SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(
        SETUP_IPC_CHANNELS.finish,
        SetRegionPayloadSchema.parse(raw),
      ),
    ),
  retrySync: command(SETUP_IPC_CHANNELS.retrySync),
  analyzeTrigger: command(SETUP_IPC_CHANNELS.analyzeTrigger),
  review: command(SETUP_IPC_CHANNELS.review),
  commit: command(SETUP_IPC_CHANNELS.commit),
  cancel: command(SETUP_IPC_CHANNELS.cancel),
  close: command(SETUP_IPC_CHANNELS.close),
})
