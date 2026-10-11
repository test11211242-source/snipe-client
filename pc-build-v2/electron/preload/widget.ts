import { contextBridge, ipcRenderer } from 'electron'

import type { CrToolsWidgetApi } from '../../shared/contracts/preload'
import type { WidgetView } from '../../shared/models/widget'
import {
  CardAssetRequestSchema,
  CardAssetResultSchema,
  EmptyWidgetPayloadSchema,
  WIDGET_IPC_CHANNELS,
  WidgetRendererReadyResultSchema,
  WidgetSettingsPatchPayloadSchema,
  WidgetSettingsResultSchema,
  WidgetStatusResultSchema,
  WidgetViewResultSchema,
} from '../../shared/contracts/widget-ipc'

const api: CrToolsWidgetApi = Object.freeze({
  rendererReady: async () => {
    WidgetRendererReadyResultSchema.parse(
      await ipcRenderer.invoke(
        WIDGET_IPC_CHANNELS.rendererReady,
        EmptyWidgetPayloadSchema.parse({}),
      ),
    )
  },
  getView: async () =>
    WidgetViewResultSchema.parse(
      await ipcRenderer.invoke(
        WIDGET_IPC_CHANNELS.getView,
        EmptyWidgetPayloadSchema.parse({}),
      ),
    ),
  onViewChanged: (listener: (view: WidgetView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, rawView: unknown): void => {
      const view = WidgetViewResultSchema.safeParse(rawView)
      if (view.success) listener(view.data)
    }
    ipcRenderer.on(WIDGET_IPC_CHANNELS.viewChanged, handler)
    return () => ipcRenderer.removeListener(WIDGET_IPC_CHANNELS.viewChanged, handler)
  },
  getCardAsset: async (rawRequest: unknown) => {
    const request = CardAssetRequestSchema.parse(rawRequest)
    return CardAssetResultSchema.parse(
      await ipcRenderer.invoke(WIDGET_IPC_CHANNELS.getCardAsset, request),
    )
  },
  updateSettings: async (rawSettings: unknown) => {
    const settings = WidgetSettingsPatchPayloadSchema.parse(rawSettings)
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
