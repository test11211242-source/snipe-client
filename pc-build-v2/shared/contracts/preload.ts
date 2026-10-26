import type { CopyPlayerTagResult } from './clipboard'
import type { BootstrapFailure } from './app'
import type {
  StreamerCommand,
  StreamerCommandResult,
  StreamerReadiness,
} from './streamer-ipc'
import type { TitleBuilder, TitleCompileResult } from './title-builder'
import type { H2HRequest, H2HLookupResult } from './h2h'
import type { WindowAction, WindowView } from './window'
import type { AppSnapshot } from '../models/application'
import type { AuthView } from '../models/auth'
import type { RealtimeStatus } from '../models/network'
import type { LoginPayload, RegisterPayload } from './auth-ipc'
import type { AppSettingsView, AppSettingsUpdate, HelloResult } from './app'
import type { DetectionPreview } from './auto-setup'
import type {
  CapturePreparationResponse,
  CaptureProfileCommand,
  CaptureProfileNamePayload,
  CaptureProfileCommandResult,
  DetectionPreviewPayload,
  PreviewPayload,
  RebindCaptureProfilePayload,
  SetRegionPayload,
  SetupCommand,
  StartSetupPayload,
} from './capture-ipc'
import type {
  CaptureProfilesView,
  CaptureSourceSnapshot,
  CaptureStatus,
} from '../models/capture'
import type { SetupFrame, SetupSessionView } from '../models/setup'
import type { MonitorPreferences, MonitorResult, MonitorView } from '../models/monitor'
import type { ModeOptions } from './game-events'
import type {
  WidgetSettings,
  WidgetSettingsPatch,
  WidgetStatus,
  WidgetView,
} from '../models/widget'
import type { CardAssetRequest, CardAssetResult } from './widget-ipc'
import type { StreamerView, StreamTitleSettings } from '../models/streamer'
import type { UpdateView } from '../models/update'

export interface CrToolsApi {
  copyPlayerTag: (tag: string) => Promise<CopyPlayerTagResult>
  setup: CrToolsSetupApi
  h2h: {
    lookup: (payload: H2HRequest) => Promise<H2HLookupResult>
    cancel: (payload: { requestId: string }) => Promise<void>
  }
  window: { command: (action: WindowAction) => Promise<WindowView> }
  streamer: {
    command: (payload: StreamerCommand) => Promise<StreamerCommandResult>
    getReadiness: () => Promise<StreamerReadiness>
    compileTitle: (payload: {
      settings: StreamTitleSettings
      builder: TitleBuilder
    }) => Promise<TitleCompileResult>
    decompileTitle: (settings: StreamTitleSettings) => Promise<TitleBuilder>
  }
  hello: () => Promise<HelloResult>
  getAppSnapshot: () => Promise<AppSnapshot>
  getAppSettings: () => Promise<AppSettingsView>
  updateAppSettings: (settings: AppSettingsUpdate) => Promise<AppSettingsView>
  openLogFolder: () => Promise<{ opened: boolean }>
  reportBootstrapFailure: (cause: BootstrapFailure) => Promise<void>
  getAuthView: () => Promise<AuthView>
  logout: () => Promise<AuthView>
  getRealtimeStatus: () => Promise<RealtimeStatus>
  listCaptureSources: () => Promise<CaptureSourceSnapshot>
  loadCapturePreviews: (payload: { revision: string }) => Promise<CaptureSourceSnapshot>
  prepareCaptureSource: (payload: PreviewPayload) => Promise<CapturePreparationResponse>
  releaseCaptureSource: (payload: PreviewPayload) => Promise<{ released: boolean }>
  startCaptureSetup: (payload: StartSetupPayload) => Promise<SetupSessionView>
  getCaptureStatus: () => Promise<CaptureStatus>
  getCaptureProfiles: () => Promise<CaptureProfilesView>
  activateCaptureProfile: (
    payload: CaptureProfileCommand,
  ) => Promise<CaptureProfileCommandResult>
  renameCaptureProfile: (
    payload: CaptureProfileNamePayload,
  ) => Promise<CaptureProfileCommandResult>
  duplicateCaptureProfile: (
    payload: CaptureProfileNamePayload,
  ) => Promise<CaptureProfileCommandResult>
  deleteCaptureProfile: (
    payload: CaptureProfileCommand,
  ) => Promise<CaptureProfileCommandResult>
  rebindCaptureProfile: (
    payload: RebindCaptureProfilePayload,
  ) => Promise<CaptureProfileCommandResult>
  getMonitorView: () => Promise<MonitorView>
  onMonitorViewChanged: (listener: (view: MonitorView) => void) => () => void
  startMonitor: () => Promise<MonitorView>
  stopMonitor: () => Promise<MonitorView>
  retryMonitorSearch: (payload: { attemptId: string }) => Promise<MonitorView>
  getMonitorHistory: (payload: {
    offset: number
    limit: number
  }) => Promise<MonitorResult[]>
  getMonitorPreferences: () => Promise<MonitorPreferences>
  updateMonitorPreferences: (
    preferences: MonitorPreferences,
  ) => Promise<MonitorPreferences>
  /** Live events for the mode picker and the mode the server holds (shared with the site). */
  getModeOptions: () => Promise<ModeOptions>
  getWidgetStatus: () => Promise<WidgetStatus>
  showWidget: () => Promise<WidgetStatus>
  toggleWidget: () => Promise<WidgetStatus>
  getCardAsset: (request: CardAssetRequest) => Promise<CardAssetResult>
  updateWidgetSettings: (patch: WidgetSettingsPatch) => Promise<WidgetSettings>
  getStreamerView: () => Promise<StreamerView>
  refreshStreamer: () => Promise<StreamerView>
  setStreamerSectionActive: (active: boolean) => Promise<StreamerView>
  getUpdateView: () => Promise<UpdateView>
  checkForUpdate: () => Promise<UpdateView>
  downloadUpdate: () => Promise<UpdateView>
  cancelUpdate: () => Promise<UpdateView>
  installUpdate: () => Promise<UpdateView>
}

export interface CrToolsSetupApi {
  getSession: () => Promise<SetupSessionView>
  getFrame: (payload: SetupCommand) => Promise<SetupFrame>
  retryDetection: (payload: SetupCommand) => Promise<SetupSessionView>
  switchToManual: (payload: SetupCommand) => Promise<SetupSessionView>
  getDetectionPreview: (
    payload: DetectionPreviewPayload,
  ) => Promise<DetectionPreview | null>
  setRegion: (payload: SetRegionPayload) => Promise<SetupSessionView>
  finish: (payload: SetRegionPayload) => Promise<SetupSessionView>
  analyzeTrigger: (payload: SetupCommand) => Promise<SetupSessionView>
  review: (payload: SetupCommand) => Promise<SetupSessionView>
  commit: (payload: SetupCommand) => Promise<SetupSessionView>
  retrySync: (payload: SetupCommand) => Promise<SetupSessionView>
  cancel: (payload: SetupCommand) => Promise<SetupSessionView>
  close: (payload: SetupCommand) => Promise<SetupSessionView>
}

export interface CrToolsAuthApi {
  getView: () => Promise<AuthView>
  retryBootstrap: () => Promise<AuthView>
  resetLogin: () => Promise<AuthView>
  login: (payload: LoginPayload) => Promise<AuthView>
  register: (payload: RegisterPayload) => Promise<AuthView>
  getUpdateView: () => Promise<UpdateView>
  checkForUpdate: () => Promise<UpdateView>
  downloadUpdate: () => Promise<UpdateView>
  cancelUpdate: () => Promise<UpdateView>
  installUpdate: () => Promise<UpdateView>
}

export interface CrToolsWidgetApi {
  rendererReady: () => Promise<void>
  getView: () => Promise<WidgetView>
  onViewChanged: (listener: (view: WidgetView) => void) => () => void
  getCardAsset: (request: CardAssetRequest) => Promise<CardAssetResult>
  updateSettings: (patch: WidgetSettingsPatch) => Promise<WidgetSettings>
  hide: () => Promise<WidgetStatus>
}
