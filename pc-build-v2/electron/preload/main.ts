import { contextBridge, ipcRenderer } from 'electron'
import {
  CLIPBOARD_CHANNELS,
  CopyPlayerTagPayloadSchema,
  CopyPlayerTagResultSchema,
} from '../../shared/contracts/clipboard'
import type { z } from 'zod'
import { setupApi } from './setup-api'
import {
  H2H_CHANNELS,
  H2HCancelSchema,
  H2HLookupResultSchema,
  H2HRequestSchema,
} from '../../shared/contracts/h2h'
import {
  WINDOW_CHANNEL,
  WindowCommandSchema,
  WindowViewSchema,
} from '../../shared/contracts/window'
import {
  TITLE_BUILDER_CHANNELS,
  CompileTitlePayloadSchema,
  TitleCompileResultSchema,
  TitleBuilderSchema,
} from '../../shared/contracts/title-builder'

import {
  OpenLogFolderResultSchema,
  BootstrapFailurePayloadSchema,
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
import type { MonitorView } from '../../shared/models/monitor'
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
  SourcePreviewsPayloadSchema,
  StartSetupPayloadSchema,
  SetupSessionResultSchema,
} from '../../shared/contracts/capture-ipc'
import {
  EmptyMonitorPayloadSchema,
  MONITOR_IPC_CHANNELS,
  MonitorPreferencesPayloadSchema,
  MonitorPreferencesResultSchema,
  MonitorViewResultSchema,
  RetrySearchPayloadSchema,
  MonitorHistoryPayloadSchema,
  MonitorHistoryResultSchema,
} from '../../shared/contracts/monitor-ipc'
import {
  EmptyWidgetPayloadSchema,
  MAIN_WIDGET_IPC_CHANNELS,
  WidgetSettingsPatchPayloadSchema,
  WidgetSettingsResultSchema,
  WidgetStatusResultSchema,
} from '../../shared/contracts/widget-ipc'
import {
  AccountMutationResultSchema,
  StreamerCommandSchema,
  StreamerCommandResultSchema,
  StreamerReadinessSchema,
  EmptyStreamerPayloadSchema,
  OverlayCopyPayloadSchema,
  OverlaySettingsPayloadSchema,
  PredictionPreferencesPayloadSchema,
  STREAMER_IPC_CHANNELS,
  StreamerAccountPayloadSchema,
  StreamerActivePayloadSchema,
  StreamerConfirmationPayloadSchema,
  StreamerViewResultSchema,
  StreamTitlePreviewResultSchema,
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

async function bootstrapResult<T>(
  schema: z.ZodType<T>,
  request: Promise<unknown>,
): Promise<T> {
  let value: unknown
  try {
    value = await request
  } catch {
    throw new Error('IPC_FAILED')
  }
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('INVALID_RESPONSE')
  return result.data
}

// The old renderer consumes views; writes use the same typed command boundary.
const streamerCommand = async (raw: unknown) => {
  const result = StreamerCommandResultSchema.parse(
    await ipcRenderer.invoke(
      STREAMER_IPC_CHANNELS.command,
      StreamerCommandSchema.parse(raw),
    ),
  )
  if (!result.ok) throw new Error(result.error.code)
  return result
}

const api: CrToolsApi = Object.freeze<CrToolsApi>({
  copyPlayerTag: async (tag: string) =>
    CopyPlayerTagResultSchema.parse(
      await ipcRenderer.invoke(
        CLIPBOARD_CHANNELS.mainCopyTag,
        CopyPlayerTagPayloadSchema.parse({ tag }),
      ),
    ),
  setup: setupApi,
  h2h: Object.freeze<CrToolsApi['h2h']>({
    lookup: async (raw) =>
      H2HLookupResultSchema.parse(
        await ipcRenderer.invoke(H2H_CHANNELS.lookup, H2HRequestSchema.parse(raw)),
      ),
    cancel: async (raw) => {
      await ipcRenderer.invoke(H2H_CHANNELS.cancel, H2HCancelSchema.parse(raw))
    },
  }),
  window: Object.freeze<CrToolsApi['window']>({
    command: async (action) =>
      WindowViewSchema.parse(
        await ipcRenderer.invoke(WINDOW_CHANNEL, WindowCommandSchema.parse({ action })),
      ),
  }),
  streamer: Object.freeze<CrToolsApi['streamer']>({
    command: async (raw) =>
      StreamerCommandResultSchema.parse(
        await ipcRenderer.invoke(
          STREAMER_IPC_CHANNELS.command,
          StreamerCommandSchema.parse(raw),
        ),
      ),
    getReadiness: async () =>
      StreamerReadinessSchema.parse(
        await ipcRenderer.invoke(
          STREAMER_IPC_CHANNELS.readiness,
          EmptyStreamerPayloadSchema.parse({}),
        ),
      ),
    compileTitle: async (raw) =>
      TitleCompileResultSchema.parse(
        await ipcRenderer.invoke(
          TITLE_BUILDER_CHANNELS.compile,
          CompileTitlePayloadSchema.parse(raw),
        ),
      ),
    decompileTitle: async (raw) =>
      TitleBuilderSchema.parse(
        await ipcRenderer.invoke(
          TITLE_BUILDER_CHANNELS.decompile,
          StreamTitleSettingsPayloadSchema.parse(raw),
        ),
      ),
  }),
  hello: async () => {
    const payload = HelloPayloadSchema.parse({
      protocolVersion: 1,
      client: 'main-renderer',
    })
    return bootstrapResult(
      HelloResultSchema,
      ipcRenderer.invoke(IPC_CHANNELS.hello, payload),
    )
  },
  getAppSnapshot: async () => {
    const payload = AppSnapshotPayloadSchema.parse({})
    return bootstrapResult(
      AppSnapshotResultSchema,
      ipcRenderer.invoke(IPC_CHANNELS.getSnapshot, payload),
    )
  },
  openLogFolder: async () =>
    OpenLogFolderResultSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.openLogFolder, {}),
    ),
  reportBootstrapFailure: async (rawPayload: unknown) => {
    await ipcRenderer.invoke(
      IPC_CHANNELS.reportBootstrapFailure,
      BootstrapFailurePayloadSchema.parse(rawPayload),
    )
  },
  getAppSettings: async () =>
    bootstrapResult(
      AppSettingsViewSchema,
      ipcRenderer.invoke(IPC_CHANNELS.getSettings, AppSettingsPayloadSchema.parse({})),
    ),
  updateAppSettings: async (rawPayload: unknown) => {
    const payload = AppSettingsUpdateSchema.parse(rawPayload)
    return AppSettingsViewSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.updateSettings, payload),
    )
  },
  getAuthView: async () =>
    bootstrapResult(
      AuthViewResultSchema,
      ipcRenderer.invoke(
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
    bootstrapResult(
      RealtimeStatusResultSchema,
      ipcRenderer.invoke(
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
  loadCapturePreviews: async (rawPayload: unknown) => {
    const payload = SourcePreviewsPayloadSchema.parse(rawPayload)
    return SourceSnapshotResultSchema.parse(
      await ipcRenderer.invoke(MAIN_CAPTURE_IPC_CHANNELS.loadPreviews, payload),
    )
  },
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
    bootstrapResult(
      CaptureStatusResultSchema,
      ipcRenderer.invoke(
        MAIN_CAPTURE_IPC_CHANNELS.getStatus,
        EmptyCapturePayloadSchema.parse({}),
      ),
    ),
  getCaptureProfiles: async () =>
    bootstrapResult(
      CaptureProfilesResultSchema,
      ipcRenderer.invoke(
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
    bootstrapResult(
      MonitorViewResultSchema,
      ipcRenderer.invoke(
        MONITOR_IPC_CHANNELS.getView,
        EmptyMonitorPayloadSchema.parse({}),
      ),
    ),
  onMonitorViewChanged: (listener: (view: MonitorView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, rawView: unknown): void => {
      const view = MonitorViewResultSchema.safeParse(rawView)
      if (view.success) listener(view.data)
    }
    ipcRenderer.on(MONITOR_IPC_CHANNELS.viewChanged, handler)
    return () => ipcRenderer.removeListener(MONITOR_IPC_CHANNELS.viewChanged, handler)
  },
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
  retryMonitorSearch: async (rawPayload: unknown) => {
    const payload = RetrySearchPayloadSchema.parse(rawPayload)
    return MonitorViewResultSchema.parse(
      await ipcRenderer.invoke(MONITOR_IPC_CHANNELS.retrySearch, payload),
    )
  },
  getMonitorHistory: async (rawPayload: unknown) => {
    const payload = MonitorHistoryPayloadSchema.parse(rawPayload)
    return MonitorHistoryResultSchema.parse(
      await ipcRenderer.invoke(MONITOR_IPC_CHANNELS.getHistory, payload),
    )
  },
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
    bootstrapResult(
      WidgetStatusResultSchema,
      ipcRenderer.invoke(
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
    const payload = WidgetSettingsPatchPayloadSchema.parse(rawPayload)
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
  connectTwitch: async () => (await streamerCommand({ action: 'twitch.connect' })).view,
  disconnectTwitch: async (raw) =>
    (
      await streamerCommand({
        action: 'twitch.disconnect',
        ...StreamerConfirmationPayloadSchema.parse(raw),
      })
    ).view,
  startPredictions: async (raw) =>
    (
      await streamerCommand({
        action: 'predictions.start',
        settings: PredictionPreferencesPayloadSchema.parse(raw),
      })
    ).view,
  stopPredictions: async () =>
    (await streamerCommand({ action: 'predictions.stop' })).view,
  startStreamerResultSetup: () => streamerEmpty(STREAMER_IPC_CHANNELS.startResultSetup),
  updateStreamTitle: async (raw) =>
    (
      await streamerCommand({
        action: 'title.save',
        settings: StreamTitleSettingsPayloadSchema.parse(raw),
      })
    ).view,
  previewStreamTitle: async (raw) =>
    StreamTitlePreviewResultSchema.parse(
      (
        await streamerCommand({
          action: 'title.preview',
          settings: StreamTitleSettingsPayloadSchema.parse(raw),
        })
      ).preview,
    ),
  setStreamTitleEnabled: async (enabled) =>
    (await streamerCommand({ action: 'title.enabled', enabled })).view,
  setStreamTitlePaused: async (paused) =>
    (await streamerCommand({ action: 'title.paused', paused })).view,
  addStreamTitleAccount: async (raw) => {
    const result = StreamerCommandResultSchema.parse(
      await ipcRenderer.invoke(
        STREAMER_IPC_CHANNELS.command,
        StreamerCommandSchema.parse({
          action: 'accounts.add',
          ...StreamerAccountPayloadSchema.parse(raw),
        }),
      ),
    )
    return AccountMutationResultSchema.parse(
      result.ok
        ? {
            ok: true,
            view: result.view,
            warning:
              result.warnings.find(
                (warning) => warning !== 'TITLE_APPLICATION_UNCONFIRMED',
              ) ?? null,
          }
        : { ok: false, error: result.error },
    )
  },
  removeStreamTitleAccount: async (tag) =>
    (await streamerCommand({ action: 'accounts.remove', tag })).view,
  resetStreamTitle: async (raw) =>
    (
      await streamerCommand({
        action: 'title.reset',
        ...StreamerConfirmationPayloadSchema.parse(raw),
      })
    ).view,
  undoStreamTitle: async (raw) =>
    (
      await streamerCommand({
        action: 'title.undo',
        ...StreamerConfirmationPayloadSchema.parse(raw),
      })
    ).view,
  restoreStreamTitle: async (raw) =>
    (
      await streamerCommand({
        action: 'title.restore',
        ...StreamerConfirmationPayloadSchema.parse(raw),
      })
    ).view,
  setDeckSharing: async (enabled) =>
    (await streamerCommand({ action: 'chat.toggle', enabled })).view,
  updateOverlay: async (raw) =>
    (
      await streamerCommand({
        action: 'widget.settings',
        settings: OverlaySettingsPayloadSchema.parse(raw),
      })
    ).view,
  rotateOverlayToken: async (raw) =>
    (
      await streamerCommand({
        action: 'widget.resetToken',
        ...StreamerConfirmationPayloadSchema.parse(raw),
      })
    ).view,
  copyOverlayUrl: async (kind) =>
    (
      await streamerCommand({
        action: 'widget.copy',
        ...OverlayCopyPayloadSchema.parse({ kind }),
      })
    ).view,
  getUpdateView: () =>
    bootstrapResult(
      UpdateViewResultSchema,
      ipcRenderer.invoke(UPDATE_IPC_CHANNELS.getView, EmptyUpdatePayloadSchema.parse({})),
    ),
  checkForUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.check),
  downloadUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.download),
  cancelUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.cancel),
  installUpdate: () => updateEmpty(UPDATE_IPC_CHANNELS.install),
})

contextBridge.exposeInMainWorld('crTools', api)
