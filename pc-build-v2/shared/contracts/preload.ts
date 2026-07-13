import type { AppSnapshot } from '../models/application'
import type { AuthView } from '../models/auth'
import type { RealtimeStatus } from '../models/network'
import type { ActivateInvitePayload, LoginPayload, RegisterPayload } from './auth-ipc'
import type { AppSettingsView, HelloResult } from './app'
import type {
  PreviewPayload,
  SetRegionPayload,
  SetupCommand,
  StartSetupPayload,
} from './capture-ipc'
import type {
  CaptureSourcePreview,
  CaptureSourceSnapshot,
  CaptureStatus,
} from '../models/capture'
import type { SetupFrame, SetupSessionView } from '../models/setup'
import type { MonitorPreferences, MonitorView } from '../models/monitor'
import type { WidgetSettings, WidgetStatus, WidgetView } from '../models/widget'
import type { CardAssetRequest, CardAssetResult } from './widget-ipc'
import type {
  OverlaySettings,
  OverlayUrlKind,
  PredictionPreferences,
  StreamerView,
  StreamTitleSettings,
} from '../models/streamer'
import type { UpdateView } from '../models/update'

export interface CrToolsApi {
  hello: () => Promise<HelloResult>
  getAppSnapshot: () => Promise<AppSnapshot>
  getAppSettings: () => Promise<AppSettingsView>
  updateAppSettings: (settings: AppSettingsView) => Promise<AppSettingsView>
  getAuthView: () => Promise<AuthView>
  logout: () => Promise<AuthView>
  getRealtimeStatus: () => Promise<RealtimeStatus>
  listCaptureSources: () => Promise<CaptureSourceSnapshot>
  getCapturePreview: (payload: PreviewPayload) => Promise<CaptureSourcePreview>
  startCaptureSetup: (payload: StartSetupPayload) => Promise<SetupSessionView>
  getCaptureStatus: () => Promise<CaptureStatus>
  getMonitorView: () => Promise<MonitorView>
  startMonitor: () => Promise<MonitorView>
  stopMonitor: () => Promise<MonitorView>
  getMonitorPreferences: () => Promise<MonitorPreferences>
  updateMonitorPreferences: (
    preferences: MonitorPreferences,
  ) => Promise<MonitorPreferences>
  getWidgetStatus: () => Promise<WidgetStatus>
  showWidget: () => Promise<WidgetStatus>
  toggleWidget: () => Promise<WidgetStatus>
  updateWidgetSettings: (settings: WidgetSettings) => Promise<WidgetSettings>
  getStreamerView: () => Promise<StreamerView>
  refreshStreamer: () => Promise<StreamerView>
  setStreamerSectionActive: (active: boolean) => Promise<StreamerView>
  connectTwitch: () => Promise<StreamerView>
  disconnectTwitch: (confirmation: { confirmed: true }) => Promise<StreamerView>
  startPredictions: (settings: PredictionPreferences) => Promise<StreamerView>
  stopPredictions: () => Promise<StreamerView>
  startStreamerResultSetup: () => Promise<StreamerView>
  updateStreamTitle: (settings: StreamTitleSettings) => Promise<StreamerView>
  setStreamTitleEnabled: (enabled: boolean) => Promise<StreamerView>
  setStreamTitlePaused: (paused: boolean) => Promise<StreamerView>
  addStreamTitleAccount: (payload: {
    tag: string
    alias: string
  }) => Promise<StreamerView>
  removeStreamTitleAccount: (tag: string) => Promise<StreamerView>
  resetStreamTitle: (confirmation: { confirmed: true }) => Promise<StreamerView>
  undoStreamTitle: (confirmation: { confirmed: true }) => Promise<StreamerView>
  restoreStreamTitle: (confirmation: { confirmed: true }) => Promise<StreamerView>
  setDeckSharing: (enabled: boolean) => Promise<StreamerView>
  updateOverlay: (settings: OverlaySettings) => Promise<StreamerView>
  rotateOverlayToken: (confirmation: { confirmed: true }) => Promise<StreamerView>
  copyOverlayUrl: (kind: OverlayUrlKind) => Promise<StreamerView>
  getUpdateView: () => Promise<UpdateView>
  checkForUpdate: () => Promise<UpdateView>
  downloadUpdate: () => Promise<UpdateView>
  cancelUpdate: () => Promise<UpdateView>
  installUpdate: () => Promise<UpdateView>
}

export interface CrToolsSetupApi {
  getSession: () => Promise<SetupSessionView>
  getFrame: (payload: SetupCommand) => Promise<SetupFrame>
  setRegion: (payload: SetRegionPayload) => Promise<SetupSessionView>
  analyzeTrigger: (payload: SetupCommand) => Promise<SetupSessionView>
  review: (payload: SetupCommand) => Promise<SetupSessionView>
  commit: (payload: SetupCommand) => Promise<SetupSessionView>
  cancel: (payload: SetupCommand) => Promise<SetupSessionView>
  close: (payload: SetupCommand) => Promise<SetupSessionView>
}

export interface CrToolsAuthApi {
  getView: () => Promise<AuthView>
  retryBootstrap: () => Promise<AuthView>
  checkInvite: () => Promise<AuthView>
  activateInvite: (payload: ActivateInvitePayload) => Promise<AuthView>
  login: (payload: LoginPayload) => Promise<AuthView>
  register: (payload: RegisterPayload) => Promise<AuthView>
}

export interface CrToolsWidgetApi {
  getView: () => Promise<WidgetView>
  getCardAsset: (request: CardAssetRequest) => Promise<CardAssetResult>
  updateSettings: (settings: WidgetSettings) => Promise<WidgetSettings>
  hide: () => Promise<WidgetStatus>
}
