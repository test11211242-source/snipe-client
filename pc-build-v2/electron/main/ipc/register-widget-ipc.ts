import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  CardAssetRequestSchema,
  CardAssetResultSchema,
  EmptyWidgetPayloadSchema,
  MAIN_WIDGET_IPC_CHANNELS,
  WIDGET_IPC_CHANNELS,
  WidgetSettingsPayloadSchema,
  WidgetSettingsResultSchema,
  WidgetStatusResultSchema,
  WidgetViewResultSchema,
} from '../../../shared/contracts/widget-ipc'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { ImageAssetService } from '../services/image-asset-service'
import type { WidgetController } from '../services/widget-controller'
import type { WindowCoordinator, WindowKind } from '../windows/window-coordinator'
import { verifyIpcSender } from './verify-ipc-sender'

interface WidgetIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  widget: WidgetController
  images: ImageAssetService
}

function verify(
  event: IpcMainInvokeEvent,
  windows: WindowCoordinator,
  kind: WindowKind,
): void {
  verifyIpcSender(event, windows, kind)
}

export function registerWidgetIpc(dependencies: WidgetIpcDependencies): () => void {
  ipcMain.handle(MAIN_WIDGET_IPC_CHANNELS.getStatus, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyWidgetPayloadSchema.parse(rawPayload)
    return WidgetStatusResultSchema.parse(dependencies.widget.getStatus())
  })
  ipcMain.handle(MAIN_WIDGET_IPC_CHANNELS.show, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyWidgetPayloadSchema.parse(rawPayload)
    return WidgetStatusResultSchema.parse(await dependencies.widget.show())
  })
  ipcMain.handle(MAIN_WIDGET_IPC_CHANNELS.toggle, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyWidgetPayloadSchema.parse(rawPayload)
    return WidgetStatusResultSchema.parse(await dependencies.widget.toggle())
  })
  ipcMain.handle(MAIN_WIDGET_IPC_CHANNELS.updateSettings, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const settings = WidgetSettingsPayloadSchema.parse(rawPayload)
    return WidgetSettingsResultSchema.parse(
      await dependencies.widget.updateSettings(settings),
    )
  })
  ipcMain.handle(WIDGET_IPC_CHANNELS.getView, (event, rawPayload) => {
    verify(event, dependencies.windows, 'widget')
    EmptyWidgetPayloadSchema.parse(rawPayload)
    return WidgetViewResultSchema.parse(dependencies.widget.getView())
  })
  ipcMain.handle(WIDGET_IPC_CHANNELS.getCardAsset, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'widget')
    const request = CardAssetRequestSchema.parse(rawPayload)
    return CardAssetResultSchema.parse(await dependencies.images.getCardAsset(request))
  })
  ipcMain.handle(WIDGET_IPC_CHANNELS.updateSettings, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'widget')
    const settings = WidgetSettingsPayloadSchema.parse(rawPayload)
    return WidgetSettingsResultSchema.parse(
      await dependencies.widget.updateSettings(settings),
    )
  })
  ipcMain.handle(WIDGET_IPC_CHANNELS.hide, (event, rawPayload) => {
    verify(event, dependencies.windows, 'widget')
    EmptyWidgetPayloadSchema.parse(rawPayload)
    return WidgetStatusResultSchema.parse(dependencies.widget.hide())
  })

  const channels = [
    ...Object.values(MAIN_WIDGET_IPC_CHANNELS),
    ...Object.values(WIDGET_IPC_CHANNELS),
  ]
  dependencies.logger.info('Widget IPC registered', { channels })
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
