import { contextBridge, ipcRenderer } from 'electron'

import {
  AppSnapshotPayloadSchema,
  AppSnapshotResultSchema,
  AppSettingsPayloadSchema,
  AppSettingsUpdateSchema,
  AppSettingsViewSchema,
  HelloPayloadSchema,
  HelloResultSchema,
  IPC_CHANNELS,
} from '../../shared/contracts/app'
import type { CrToolsApi } from '../../shared/contracts/preload'
import {
  AuthViewResultSchema,
  EmptyPayloadSchema,
  MAIN_NETWORK_IPC_CHANNELS,
  RealtimeStatusResultSchema,
} from '../../shared/contracts/auth-ipc'
import {
  CapturePreparationResponseSchema,
  CaptureProfileCommandSchema,
  CaptureProfileMutationResultSchema,
  CaptureProfileNamePayloadSchema,
  CaptureProfilesResultSchema,
  CaptureStatusResultSchema,
  EmptyCapturePayloadSchema,
  MAIN_CAPTURE_IPC_CHANNELS,
  PreviewPayloadSchema,
  ReleasePreparationResultSchema,
  RebindCaptureProfilePayloadSchema,
  SourceSnapshotResultSchema,
  StartSetupPayloadSchema,
  SetupSessionResultSchema,
} from '../../shared/contracts/capture-ipc'
import {
  EmptyMonitorPayloadSchema,
  MONITOR_IPC_CHANNELS,
  MonitorPreferencesPayloadSchema,
  MonitorPreferencesResultSchema,
  MonitorViewResultSchema,
} from '../../shared/contracts/monitor-ipc'
import {
  EmptyWidgetPayloadSchema,
  MAIN_WIDGET_IPC_CHANNELS,
  WidgetSettingsPayloadSchema,
  WidgetSettingsResultSchema,
  WidgetStatusResultSchema,
} from '../../shared/contracts/widget-ipc'
import {
  EmptyStreamerPayloadSchema,
  OverlayCopyPayloadSchema,
  OverlaySettingsPayloadSchema,
  PredictionPreferencesPayloadSchema,
  STREAMER_IPC_CHANNELS,
  StreamerAccountPayloadSchema,
  StreamerActivePayloadSchema,
  StreamerBooleanPayloadSchema,
  StreamerConfirmationPayloadSchema,
  StreamerPausedPayloadSchema,
  StreamerTagPayloadSchema,
  StreamerViewResultSchema,
  StreamTitleSettingsPayloadSchema,
} from '../../shared/contracts/streamer-ipc'
import {
  EmptyUpdatePayloadSchema,
  UPDATE_IPC_CHANNELS,
  UpdateViewResultSchema,
} from '../../shared/contracts/update'

const streamerEmpty = async (channel: string) =>
  StreamerViewResultSchema.parse(
    await ipcRenderer.invoke(channel, EmptyStreamerPayloadSchema.parse({})),
  )

const updateEmpty = async (channel: string) =>
  UpdateViewResultSchema.parse(
    await ipcRenderer.invoke(channel, EmptyUpdatePayloadSchema.parse({})),
  )

const api: CrToolsApi = Object.freeze({
  hello: async () => {
    const payload = HelloPayloadSchema.parse({
      protocolVersion: 1,
      client: 'main-renderer',
    })
    return HelloResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.hello, payload))
  },
  getAppSnapshot: async () => {
    const payload = AppSnapshotPayloadSchema.parse({})
    return AppSnapshotResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.getSnapshot, payload),
    )
  },
  getAppSettings: async () =>
    AppSettingsViewSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.getSettings,
        AppSettingsPayloadSchema.parse({}),
      ),
    ),
  updateAppSettings: async (rawPayload: unknown) => {
    const payload = AppSettingsUpdateSchema.parse(rawPayload)
    return AppSettingsViewSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.updateSettings, payload),
    )
  },
  getAuthView: async () =>
    AuthViewResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_NETWORK_IPC_CHANNELS.getAuthView,
        EmptyPayloadSchema.parse({}),
      ),
    ),
  logout: async () =>
    AuthViewResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_NETWORK_IPC_CHANNELS.logout,
        EmptyPayloadSchema.parse({}),
      ),
    ),
  getRealtimeStatus: async () =>
    RealtimeStatusResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_NETWORK_IPC_CHANNELS.getRealtimeStatus,
        EmptyPayloadSchema.parse({}),
      ),
    ),
  listCaptureSources: async () =>
    SourceSnapshotResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_CAPTURE_IPC_CHANNELS.listSources,
        EmptyCapturePayloadSchema.parse({}),
      ),
    ),
  prepareCaptureSource: async (rawPayload: unknown) => {
    const payload = PreviewPayloadSchema.parse(rawPayload)
    return CapturePreparationResponseSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.prepareSource, payload),
    )
  },
  releaseCaptureSource: async (rawPayload: unknown) => {
    const payload = PreviewPayloadSchema.parse(rawPayload)
    return ReleasePreparationResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.releaseSource, payload),
    )
  },
  startCaptureSetup: async (rawPayload: unknown) => {
    const payload = StartSetupPayloadSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.startSetup, payload),
    )
  },
  getCaptureStatus: async () =>
    CaptureStatusResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_CAPTURE_IPC_CHANNELS.getStatus,
        EmptyCapturePayloadSchema.parse({}),
      ),
    ),
  getCaptureProfiles: async () =>
    CaptureProfilesResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_CAPTURE_IPC_CHANNELS.getProfiles,
        EmptyCapturePayloadSchema.parse({}),
      ),
    ),
  activateCaptureProfile: async (rawPayload: unknown) => {
    const payload = CaptureProfileCommandSchema.parse(rawPayload)
    return CaptureProfileMutationResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.activateProfile, payload),
    )
  },
  renameCaptureProfile: async (rawPayload: unknown) => {
    const payload = CaptureProfileNamePayloadSchema.parse(rawPayload)
    return CaptureProfileMutationResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.renameProfile, payload),
    )
  },
  duplicateCaptureProfile: async (rawPayload: unknown) => {
    const payload = CaptureProfileNamePayloadSchema.parse(rawPayload)
    return CaptureProfileMutationResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.duplicateProfile, payload),
    )
  },
  deleteCaptureProfile: async (rawPayload: unknown) => {
    const payload = CaptureProfileCommandSchema.parse(rawPayload)
    return CaptureProfileMutationResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.deleteProfile, payload),
    )
  },
  rebindCaptureProfile: async (rawPayload: unknown) => {
    const payload = RebindCaptureProfilePayloadSchema.parse(rawPayload)
    return CaptureProfileMutationResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.rebindProfile, payload),
    )
  },
  getMonitorView: async () =>
    MonitorViewResultSchema.parse(
      await ipcRenderer.invoke(
        MONITOR_IPC_CHANNELS.getView,
        EmptyMonitorPayloadSchema.parse({}),
      ),
    ),
  startMonitor: async () =>
    MonitorViewResultSchema.parse(
      await ipcRenderer.invoke(
        MONITOR_IPC_CHANNELS.start,
        EmptyMonitorPayloadSchema.parse({}),
      ),
    ),
  stopMonitor: async () =>
    MonitorViewResultSchema.parse(
      await ipcRenderer.invoke(
        MONITOR_IPC_CHANNELS.stop,
        EmptyMonitorPayloadSchema.parse({}),
      ),
    ),
  getMonitorPreferences: async () =>
    MonitorPreferencesResultSchema.parse(
      await ipcRenderer.invoke(
        MONITOR_IPC_CHANNELS.getPreferences,
        EmptyMonitorPayloadSchema.parse({}),
      ),
    ),
  updateMonitorPreferences: async (rawPayload: unknown) => {
    const payload = MonitorPreferencesPayloadSchema.parse(rawPayload)
    return MonitorPreferencesResultSchema.parse(
      await ipcRenderer.invoke(MONITOR_IPC_CHANNELS.updatePreferences, payload),
    )
  },
  getWidgetStatus: async () =>
    WidgetStatusResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_WIDGET_IPC_CHANNELS.getStatus,
        EmptyWidgetPayloadSchema.parse({}),
      ),
    ),
  showWidget: async () =>
    WidgetStatusResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_WIDGET_IPC_CHANNELS.show,
        EmptyWidgetPayloadSchema.parse({}),
      ),
    ),
  toggleWidget: async () =>
    WidgetStatusResultSchema.parse(
      await ipcRenderer.invoke(
        MAIN_WIDGET_IPC_CHANNELS.toggle,
        EmptyWidgetPayloadSchema.parse({}),
      ),
    ),
  updateWidgetSettings: async (rawPayload: unknown) => {
    const payload = WidgetSettingsPayloadSchema.parse(rawPayload)
    return WidgetSettingsResultSchema.parse(
      await ipcRenderer.invoke(MAIN_WIDGET_IPC_CHANNELS.updateSettings, payload),
    )
  },
  getStreamerView: () => streamerEmpty(STREAMER_IPC_CHANNELS.getView),
  refreshStreamer: () => streamerEmpty(STREAMER_IPC_CHANNELS.refresh),
  setStreamerSectionActive: async (active: boolean) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.setActive,
        StreamerActivePayloadSchema.parse({ active }),
      ),
    ),
  connectTwitch: () => streamerEmpty(STREAMER_IPC_CHANNELS.connectTwitch),
  disconnectTwitch: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.disconnectTwitch,
        StreamerConfirmationPayloadSchema.parse(rawPayload),
      ),
    ),
  startPredictions: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.startPredictions,
        PredictionPreferencesPayloadSchema.parse(rawPayload),
      ),
    ),
  stopPredictions: () => streamerEmpty(STREAMER_IPC_CHANNELS.stopPredictions),
  startStreamerResultSetup: () => streamerEmpty(STREAMER_IPC_CHANNELS.startResultSetup),
  updateStreamTitle: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.updateTitle,
        StreamTitleSettingsPayloadSchema.parse(rawPayload),
      ),
    ),
  setStreamTitleEnabled: async (enabled: boolean) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.setTitleEnabled,
        StreamerBooleanPayloadSchema.parse({ enabled }),
      ),
    ),
  setStreamTitlePaused: async (paused: boolean) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.setTitlePaused,
        StreamerPausedPayloadSchema.parse({ paused }),
      ),
    ),
  addStreamTitleAccount: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.addTitleAccount,
        StreamerAccountPayloadSchema.parse(rawPayload),
      ),
    ),
  removeStreamTitleAccount: async (tag: string) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.removeTitleAccount,
        StreamerTagPayloadSchema.parse({ tag }),
      ),
    ),
  resetStreamTitle: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.resetTitle,
        StreamerConfirmationPayloadSchema.parse(rawPayload),
      ),
    ),
  undoStreamTitle: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.undoTitle,
        StreamerConfirmationPayloadSchema.parse(rawPayload),
      ),
    ),
  restoreStreamTitle: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.restoreTitle,
        StreamerConfirmationPayloadSchema.parse(rawPayload),
      ),
    ),
  setDeckSharing: async (enabled: boolean) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.setDeckSharing,
        StreamerBooleanPayloadSchema.parse({ enabled }),
      ),
    ),
  updateOverlay: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.updateOverlay,
        OverlaySettingsPayloadSchema.parse(rawPayload),
      ),
    ),
  rotateOverlayToken: async (rawPayload: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.rotateOverlayToken,
        StreamerConfirmationPayloadSchema.parse(rawPayload),
      ),
    ),
  copyOverlayUrl: async (kind: unknown) =>
    StreamerViewResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.copyOverlayUrl,
        OverlayCopyPayloadSchema.parse({ kind }),
      ),
    ),
  getUpdateView: () => updateEmpty(UPDATE_IPC_CHANNELS.getView),
  checkForUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.check),
  downloadUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.download),
  cancelUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.cancel),
  installUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.install),
})

contextBridge.exposeInMainWorld('crTools', api)
