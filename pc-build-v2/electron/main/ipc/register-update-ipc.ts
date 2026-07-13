import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  EmptyUpdatePayloadSchema,
  UPDATE_IPC_CHANNELS,
  UpdateViewResultSchema,
} from '../../../shared/contracts/update'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { UpdateService } from '../services/update-service'
import type { WindowCoordinator } from '../windows/window-coordinator'

interface UpdateIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  updater: UpdateService
}

export function registerUpdateIpc(dependencies: UpdateIpcDependencies): () => void {
  const verify = (event: IpcMainInvokeEvent, rawPayload: unknown): void => {
    dependencies.windows.assertSender(event.sender, event.senderFrame?.url ?? '', 'main')
    EmptyUpdatePayloadSchema.parse(rawPayload)
  }
  ipcMain.handle(UPDATE_IPC_CHANNELS.getView, (event, payload) => {
    verify(event, payload)
    return UpdateViewResultSchema.parse(dependencies.updater.getView())
  })
  ipcMain.handle(UPDATE_IPC_CHANNELS.check, async (event, payload) => {
    verify(event, payload)
    return UpdateViewResultSchema.parse(await dependencies.updater.check())
  })
  ipcMain.handle(UPDATE_IPC_CHANNELS.download, async (event, payload) => {
    verify(event, payload)
    return UpdateViewResultSchema.parse(await dependencies.updater.download())
  })
  ipcMain.handle(UPDATE_IPC_CHANNELS.cancel, (event, payload) => {
    verify(event, payload)
    return UpdateViewResultSchema.parse(dependencies.updater.cancel())
  })
  ipcMain.handle(UPDATE_IPC_CHANNELS.install, async (event, payload) => {
    verify(event, payload)
    return UpdateViewResultSchema.parse(await dependencies.updater.install())
  })

  dependencies.logger.info('Update IPC registered', {
    channels: Object.values(UPDATE_IPC_CHANNELS),
  })
  return () => {
    for (const channel of Object.values(UPDATE_IPC_CHANNELS))
      ipcMain.removeHandler(channel)
  }
}
