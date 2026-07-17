import { contextBridge, ipcRenderer } from 'electron'

import {
  EmptyCapturePayloadSchema,
  SETUP_IPC_CHANNELS,
  SetRegionPayloadSchema,
  SetupCommandSchema,
  SetupFrameResultSchema,
  SetupSessionResultSchema,
} from '../../shared/contracts/capture-ipc'
import type { CrToolsSetupApi } from '../../shared/contracts/preload'

const command = (channel: string) => async (rawPayload: unknown) => {
  const payload = SetupCommandSchema.parse(rawPayload)
  return SetupSessionResultSchema.parse(await ipcRenderer.invoke(channel, payload))
}

const api: CrToolsSetupApi = Object.freeze({
  getSession: async () =>
    SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(
        SETUP_IPC_CHANNELS.getSession,
        EmptyCapturePayloadSchema.parse({}),
      ),
    ),
  getFrame: async (rawPayload: unknown) => {
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupFrameResultSchema.parse(
      await ipcRenderer.invoke(SETUP_IPC_CHANNELS.getFrame, payload),
    )
  },
  setRegion: async (rawPayload: unknown) => {
    const payload = SetRegionPayloadSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(SETUP_IPC_CHANNELS.setRegion, payload),
    )
  },
  finish: async (rawPayload: unknown) => {
    const payload = SetRegionPayloadSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(SETUP_IPC_CHANNELS.finish, payload),
    )
  },
  analyzeTrigger: command(SETUP_IPC_CHANNELS.analyzeTrigger),
  review: command(SETUP_IPC_CHANNELS.review),
  commit: command(SETUP_IPC_CHANNELS.commit),
  cancel: command(SETUP_IPC_CHANNELS.cancel),
  close: command(SETUP_IPC_CHANNELS.close),
})

contextBridge.exposeInMainWorld('crToolsSetup', api)
