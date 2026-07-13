import { contextBridge, ipcRenderer } from 'electron'

import type { CrToolsWidgetApi } from '../../shared/contracts/preload'
import {
  CardAssetRequestSchema,
  CardAssetResultSchema,
  EmptyWidgetPayloadSchema,
  WIDGET_IPC_CHANNELS,
  WidgetSettingsPayloadSchema,
  WidgetSettingsResultSchema,
  WidgetStatusResultSchema,
  WidgetViewResultSchema,
} from '../../shared/contracts/widget-ipc'

const api: CrToolsWidgetApi = Object.freeze({
  getView: async () =>
    WidgetViewResultSchema.parse(
      await ipcRenderer.invoke(
        WIDGET_IPC_CHANNELS.getView,
        EmptyWidgetPayloadSchema.parse({}),
      ),
    ),
  getCardAsset: async (rawRequest: unknown) => {
    const request = CardAssetRequestSchema.parse(rawRequest)
    return CardAssetResultSchema.parse(
      await ipcRenderer.invoke(WIDGET_IPC_CHANNELS.getCardAsset, request),
    )
  },
  updateSettings: async (rawSettings: unknown) => {
    const settings = WidgetSettingsPayloadSchema.parse(rawSettings)
    return WidgetSettingsResultSchema.parse(
      await ipcRenderer.invoke(WIDGET_IPC_CHANNELS.updateSettings, settings),
    )
  },
  hide: async () =>
    WidgetStatusResultSchema.parse(
      await ipcRenderer.invoke(
        WIDGET_IPC_CHANNELS.hide,
        EmptyWidgetPayloadSchema.parse({}),
      ),
    ),
})

contextBridge.exposeInMainWorld('crToolsWidget', api)
