import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  AppSnapshotPayloadSchema,
  AppSnapshotResultSchema,
  AppSettingsPayloadSchema,
  AppSettingsUpdateSchema,
  AppSettingsViewSchema,
  HelloPayloadSchema,
  HelloResultSchema,
  IPC_CHANNELS,
} from '../../../shared/contracts/app'
import type { AppSnapshot } from '../../../shared/models/application'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { AppSettingsController } from '../services/app-settings-controller'
import type { WindowCoordinator } from '../windows/window-coordinator'
import { verifyIpcSender } from './verify-ipc-sender'

interface AppIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  getSnapshot: () => AppSnapshot
  settings: AppSettingsController
}

function verifyMainSender(event: IpcMainInvokeEvent, windows: WindowCoordinator): void {
  verifyIpcSender(event, windows, 'main')
}

export function registerAppIpc(dependencies: AppIpcDependencies): () => void {
  ipcMain.handle(IPC_CHANNELS.hello, (event, rawPayload: unknown) => {
    verifyMainSender(event, dependencies.windows)
    HelloPayloadSchema.parse(rawPayload)
    return HelloResultSchema.parse({
      protocolVersion: 1,
      message: 'hello from CR Tools V2',
    })
  })

  ipcMain.handle(IPC_CHANNELS.getSnapshot, (event, rawPayload: unknown) => {
    verifyMainSender(event, dependencies.windows)
    AppSnapshotPayloadSchema.parse(rawPayload)
    return AppSnapshotResultSchema.parse(dependencies.getSnapshot())
  })

  ipcMain.handle(IPC_CHANNELS.getSettings, (event, rawPayload: unknown) => {
    verifyMainSender(event, dependencies.windows)
    AppSettingsPayloadSchema.parse(rawPayload)
    return AppSettingsViewSchema.parse(dependencies.settings.getView())
  })

  ipcMain.handle(IPC_CHANNELS.updateSettings, async (event, rawPayload: unknown) => {
    verifyMainSender(event, dependencies.windows)
    const payload = AppSettingsUpdateSchema.parse(rawPayload)
    return AppSettingsViewSchema.parse(await dependencies.settings.update(payload))
  })

  dependencies.logger.info('Application IPC registered', {
    channels: Object.values(IPC_CHANNELS),
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.hello)
    ipcMain.removeHandler(IPC_CHANNELS.getSnapshot)
    ipcMain.removeHandler(IPC_CHANNELS.getSettings)
    ipcMain.removeHandler(IPC_CHANNELS.updateSettings)
  }
}
