import { vi, type Mock } from 'vitest'

import type { AppSettingsView } from '../../../shared/contracts/app'
import type { AuthView } from '../../../shared/models/auth'
import {
  CaptureProfileSummarySchema,
  type CaptureProfilesView,
} from '../../../shared/models/capture'
import type { MonitorResult, MonitorView } from '../../../shared/models/monitor'
import type { RealtimeStatus } from '../../../shared/models/network'
import type { UpdateView } from '../../../shared/models/update'
import { monitorViewFixture } from '../../../tests/monitor-fixtures'

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function profilesFixture(
  names: readonly string[] = ['Основной'],
): CaptureProfilesView {
  if (names.length === 0) return { revision: null, activeProfileId: null, profiles: [] }
  return {
    revision: 1,
    activeProfileId: uuid(1),
    profiles: names.map((name, index) =>
      CaptureProfileSummarySchema.parse({
        profileId: uuid(index + 1),
        profileName: name,
        isActive: index === 0,
        createdAt: '2026-10-02T12:00:00.000Z',
        updatedAt: '2026-10-02T12:00:00.000Z',
        configurationRevision: 1,
        configurationFingerprint: 'a'.repeat(64),
        committedAt: '2026-10-02T12:00:00.000Z',
        sourceKind: 'window',
        sourceLabel: 'BlueStacks App Player',
        sourceHealth: { state: 'available', reason: null },
        calibrationHealth: 'validated',
        resultConfigured: false,
      }),
    ),
  }
}

export function authFixture(
  roles: readonly ('user' | 'streamer')[] = ['user'],
): AuthView {
  return {
    state: 'AUTHENTICATED',
    error: null,
    user: {
      id: 'user-1',
      username: 'ArtCS',
      email: 'art@example.ru',
      role: roles[roles.length - 1] ?? 'user',
      roles: [...roles],
    },
  }
}

export const updateIdle: UpdateView = {
  state: 'IDLE',
  currentVersion: '0.1.23',
  availableVersion: null,
  critical: false,
  releaseNotes: [],
  progress: null,
  error: null,
}

/** Async capability mock; implementations may take any arguments. */
export type AsyncMock = Mock<(...args: never[]) => Promise<unknown>>

export interface BridgeOptions {
  auth?: AuthView
  profiles?: CaptureProfilesView
  monitor?: MonitorView
  update?: UpdateView
  /** Resource names whose load rejects (until `recover` is called). */
  failing?: readonly string[]
  /** Older history entries returned by getMonitorHistory. */
  history?: readonly MonitorResult[]
}

export interface Bridge {
  crTools: Record<string, unknown> & {
    onMonitorViewChanged: ReturnType<typeof vi.fn>
    startMonitor: AsyncMock
    stopMonitor: ReturnType<typeof vi.fn>
    getCaptureProfiles: ReturnType<typeof vi.fn>
    getMonitorView: ReturnType<typeof vi.fn>
    getUpdateView: ReturnType<typeof vi.fn>
    getAppSnapshot: ReturnType<typeof vi.fn>
    getAppSettings: ReturnType<typeof vi.fn>
    activateCaptureProfile: ReturnType<typeof vi.fn>
    downloadUpdate: ReturnType<typeof vi.fn>
    window: { command: ReturnType<typeof vi.fn> }
    logout: ReturnType<typeof vi.fn>
    reportBootstrapFailure: ReturnType<typeof vi.fn>
    retryMonitorSearch: AsyncMock
    getMonitorHistory: AsyncMock
    updateMonitorPreferences: AsyncMock
    getCardAsset: AsyncMock
    copyPlayerTag: AsyncMock
    showWidget: AsyncMock
    setStreamerSectionActive: AsyncMock
    getRealtimeStatus: AsyncMock
    updateAppSettings: AsyncMock
    checkForUpdate: AsyncMock
    cancelUpdate: AsyncMock
    installUpdate: AsyncMock
    openLogFolder: AsyncMock
    getWidgetStatus: AsyncMock
    updateWidgetSettings: AsyncMock
    toggleWidget: AsyncMock
    listCaptureSources: AsyncMock
    loadCapturePreviews: AsyncMock
    prepareCaptureSource: AsyncMock
    releaseCaptureSource: AsyncMock
    startCaptureSetup: AsyncMock
    renameCaptureProfile: AsyncMock
    duplicateCaptureProfile: AsyncMock
    deleteCaptureProfile: AsyncMock
    rebindCaptureProfile: AsyncMock
    setup: Record<
      | 'startResult'
      | 'getSession'
      | 'getFrame'
      | 'setRegion'
      | 'finish'
      | 'analyzeTrigger'
      | 'review'
      | 'commit'
      | 'retrySync'
      | 'retryDetection'
      | 'switchToManual'
      | 'getDetectionPreview'
      | 'cancel'
      | 'close',
      AsyncMock
    >
    h2h: { lookup: AsyncMock; cancel: AsyncMock }
  }
  /** Delivers a monitor push event to every subscribed listener. */
  push: (view: MonitorView) => void
  unsubscribe: ReturnType<typeof vi.fn>
  recover: () => void
}

/** Installs a fake window.crTools for the new renderer. Test-only. */
export function installBridge(options: BridgeOptions = {}): Bridge {
  const failing = new Set(options.failing)
  const listeners = new Set<(view: MonitorView) => void>()
  const unsubscribe = vi.fn()
  const monitor =
    options.monitor ?? monitorViewFixture({ state: 'READY', runIntent: true })
  const settings: AppSettingsView = {
    reducedMotion: false,
    launchAtStartup: false,
    diagnosticsEnabled: false,
    autoStartMonitoring: true,
    closeToTray: true,
    notifyOpponentFound: true,
  }
  const realtime: RealtimeStatus = {
    state: 'READY',
    desiredConnected: true,
    reconnectAttempt: 0,
    unknownEventCount: 0,
  }
  const load =
    <T>(name: string, value: T) =>
    (): Promise<T> =>
      failing.has(name) ? Promise.reject(new Error('IPC_FAILED')) : Promise.resolve(value)

  const crTools = {
    hello: vi.fn(
      load('protocol', { protocolVersion: 1, message: 'hello from CR Tools V2' }),
    ),
    getAppSnapshot: vi.fn(
      load('snapshot', { lifecycle: 'READY', version: '0.1.23', settingsVersion: 2 }),
    ),
    getAuthView: vi.fn(load('auth', options.auth ?? authFixture())),
    getRealtimeStatus: vi.fn(load('realtime', realtime)),
    getCaptureProfiles: vi.fn(load('profiles', options.profiles ?? profilesFixture())),
    getMonitorView: vi.fn(load('monitor', monitor)),
    getAppSettings: vi.fn(load('settings', settings)),
    getUpdateView: vi.fn(load('update', options.update ?? updateIdle)),
    updateAppSettings: vi.fn((patch: Partial<AppSettingsView>) =>
      Promise.resolve({ ...settings, ...patch }),
    ),
    reportBootstrapFailure: vi.fn(() => Promise.resolve()),
    onMonitorViewChanged: vi.fn((listener: (view: MonitorView) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        unsubscribe()
      }
    }),
    startMonitor: vi.fn(() => Promise.resolve(monitor)),
    stopMonitor: vi.fn(() =>
      Promise.resolve({ ...monitor, state: 'STOPPED', runIntent: false }),
    ),
    retryMonitorSearch: vi.fn(() => Promise.resolve(monitor)),
    getMonitorHistory: vi.fn(() => Promise.resolve(options.history ?? [])),
    updateMonitorPreferences: vi.fn((preferences: { deckMode: 'pol' | 'gt' }) =>
      Promise.resolve(preferences),
    ),
    getCardAsset: vi.fn(() => Promise.resolve({ kind: 'unavailable' })),
    copyPlayerTag: vi.fn(() => Promise.resolve({ copied: true })),
    showWidget: vi.fn(() => Promise.resolve({})),
    setStreamerSectionActive: vi.fn(() => Promise.reject(new Error('No streamer'))),
    getStreamerView: vi.fn(() => Promise.reject(new Error('No streamer'))),
    refreshStreamer: vi.fn(() => Promise.reject(new Error('No streamer'))),
    streamer: {
      command: vi.fn(() => Promise.reject(new Error('No streamer'))),
      getReadiness: vi.fn(() => Promise.reject(new Error('No streamer'))),
      compileTitle: vi.fn(() => Promise.reject(new Error('No streamer'))),
      decompileTitle: vi.fn(() => Promise.reject(new Error('No streamer'))),
    },
    openLogFolder: vi.fn(() => Promise.resolve({ opened: true })),
    getWidgetStatus: vi.fn(() => Promise.reject(new Error('No widget'))),
    updateWidgetSettings: vi.fn(() => Promise.reject(new Error('No widget'))),
    toggleWidget: vi.fn(() => Promise.reject(new Error('No widget'))),
    h2h: {
      lookup: vi.fn(({ requestId }: { requestId: string }) =>
        Promise.resolve({
          capability: 'unavailable',
          requestId,
          retryAt: null,
          code: 'H2H_REQUEST_FAILED',
        }),
      ),
      cancel: vi.fn(() => Promise.resolve()),
    },
    activateCaptureProfile: vi.fn(),
    listCaptureSources: vi.fn(() =>
      Promise.resolve({
        revision: 'c'.repeat(32),
        expiresAt: Date.now() + 30_000,
        sources: [],
      }),
    ),
    loadCapturePreviews: vi.fn(() => Promise.reject(new Error('No previews'))),
    prepareCaptureSource: vi.fn(),
    releaseCaptureSource: vi.fn(() => Promise.resolve({ released: true })),
    startCaptureSetup: vi.fn(),
    renameCaptureProfile: vi.fn(),
    duplicateCaptureProfile: vi.fn(),
    deleteCaptureProfile: vi.fn(),
    rebindCaptureProfile: vi.fn(),
    setup: {
      startResult: vi.fn(),
      getSession: vi.fn(() => Promise.reject(new Error('No setup is active'))),
      getFrame: vi.fn(),
      retryDetection: vi.fn(),
      switchToManual: vi.fn(),
      getDetectionPreview: vi.fn(),
      setRegion: vi.fn(),
      finish: vi.fn(),
      analyzeTrigger: vi.fn(),
      review: vi.fn(),
      commit: vi.fn(),
      retrySync: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    },
    logout: vi.fn(() =>
      Promise.resolve({ state: 'UNAUTHENTICATED', user: null, error: null }),
    ),
    checkForUpdate: vi.fn(() => Promise.resolve(options.update ?? updateIdle)),
    downloadUpdate: vi.fn(() => Promise.resolve(options.update ?? updateIdle)),
    cancelUpdate: vi.fn(() => Promise.resolve(options.update ?? updateIdle)),
    installUpdate: vi.fn(() => Promise.resolve(options.update ?? updateIdle)),
    window: { command: vi.fn(() => Promise.resolve({ maximized: false })) },
  }
  Object.defineProperty(window, 'crTools', { configurable: true, value: crTools })
  return {
    crTools,
    push: (view) => listeners.forEach((listener) => listener(view)),
    unsubscribe,
    recover: () => failing.clear(),
  }
}
