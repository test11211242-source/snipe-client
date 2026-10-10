// Visual-check preload: exposes a deterministic fake window.crTools built from a fixture.
// Test tooling only; never packaged and never exposes production capabilities.
const { contextBridge, ipcRenderer } = require('electron')

const fixture = ipcRenderer.sendSync('visual:fixture')
const now = Date.now()
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stats = {
  triggers: 13,
  requests: 12,
  droppedActions: 0,
  playersFound: 9,
  playersNotFound: 1,
  recognitionFailures: 1,
  serviceErrors: 1,
}
const profile = (n, name, label, kind, active, health) => ({
  profileId: uuid(n),
  profileName: name,
  isActive: active,
  createdAt: '2026-10-02T12:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
  configurationRevision: 1,
  configurationFingerprint: 'a'.repeat(64),
  committedAt: '2026-10-02T12:00:00.000Z',
  sourceKind: kind,
  sourceLabel: label,
  sourceHealth: { state: health, reason: null },
  calibrationHealth: 'validated',
  resultConfigured: false,
})
const profiles = fixture.noProfiles
  ? { revision: null, activeProfileId: null, profiles: [] }
  : {
      revision: 3,
      activeProfileId: uuid(1),
      profiles: [
        profile(
          1,
          'Основной',
          'BlueStacks App Player',
          'window',
          true,
          fixture.sourceMissing ? 'missing' : 'available',
        ),
        profile(2, 'Твинк', 'MEmu Play', 'window', false, 'missing'),
        profile(3, 'Планшет', 'Экран 2', 'display', false, 'unknown'),
      ],
    }
const monitor = {
  state: fixture.monitorState ?? 'READY',
  preferences: { deckMode: 'pol' },
  readiness: {
    authenticated: true,
    captureConfigured: !fixture.noProfiles,
    sourceAvailable: !fixture.sourceMissing,
  },
  error: null,
  startedAt: new Date(now - 751000).toISOString(),
  stats,
  results: [],
  runIntent: (fixture.monitorState ?? 'READY') !== 'STOPPED',
  search: null,
  session: null,
  summary: null,
  historyError: null,
}
const roles = fixture.player ? ['user'] : ['user', 'streamer']
const data = {
  hello: { protocolVersion: 1, message: 'hello from CR Tools V2' },
  snapshot: { lifecycle: 'READY', version: '2.5.0', settingsVersion: 2 },
  auth: {
    state: 'AUTHENTICATED',
    error: null,
    user: {
      id: 'u1',
      username: 'ArtCS',
      email: 'art.cs@example.ru',
      role: roles[roles.length - 1],
      roles,
    },
  },
  realtime: {
    state: fixture.offline ? 'BACKOFF' : 'READY',
    desiredConnected: true,
    reconnectAttempt: fixture.offline ? 3 : 0,
    unknownEventCount: 0,
  },
  settings: {
    reducedMotion: false,
    launchAtStartup: true,
    diagnosticsEnabled: false,
    autoStartMonitoring: true,
    closeToTray: true,
    notifyOpponentFound: true,
  },
  update: fixture.update ?? {
    state: 'IDLE',
    currentVersion: '2.5.0',
    availableVersion: null,
    critical: false,
    releaseNotes: [],
    progress: null,
    error: null,
  },
}
const ok = (v) => () => Promise.resolve(v)
const fail = () => Promise.reject(new Error('IPC_FAILED'))
const failing = new Set(fixture.failing ?? [])
const pick = (name, v) => (failing.has(name) ? fail : ok(v))

contextBridge.exposeInMainWorld('crTools', {
  window: { command: () => Promise.resolve({ maximized: false }) },
  hello: pick('protocol', data.hello),
  getAppSnapshot: pick('snapshot', data.snapshot),
  getAuthView: pick('auth', data.auth),
  getRealtimeStatus: pick('realtime', data.realtime),
  getCaptureProfiles: pick('profiles', profiles),
  getMonitorView: pick('monitor', monitor),
  onMonitorViewChanged: () => () => undefined,
  getAppSettings: pick('settings', data.settings),
  getUpdateView: pick('update', data.update),
  reportBootstrapFailure: ok(undefined),
  startMonitor: ok(monitor),
  stopMonitor: ok({ ...monitor, state: 'STOPPED', runIntent: false }),
  logout: ok({ state: 'UNAUTHENTICATED', user: null, error: null }),
})
