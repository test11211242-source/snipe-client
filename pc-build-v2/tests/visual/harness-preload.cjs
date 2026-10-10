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
const CARD_NAMES = [
  'Бочка гоблинов',
  'Принцесса',
  'Рыцарь',
  'Ракета',
  'Тесла',
  'Скелеты',
  'Ледяной дух',
  'Бревно',
]
const HUES = [120, 290, 40, 20, 200, 0, 190, 30]
const art = (index) => {
  const hue = HUES[index % 8]
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="360" viewBox="0 0 300 360">' +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 55%)"/><stop offset="1" stop-color="hsl(${hue} 50% 28%)"/></linearGradient></defs>` +
    `<rect x="8" y="8" width="284" height="344" rx="28" fill="url(#g)" stroke="hsl(${hue} 30% 80%)" stroke-width="6"/>` +
    `<text x="150" y="215" font-size="120" text-anchor="middle" fill="white" fill-opacity=".85" font-family="Segoe UI">${index + 1}</text></svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}
const cardAsset = ({ cardIndex }) =>
  Promise.resolve(
    fixture.noArt
      ? { kind: 'unavailable' }
      : { kind: 'available', dataUrl: art(cardIndex) },
  )
const minutesAgo = (minutes) => new Date(now - minutes * 60_000).toISOString()
const expandDeck = (offset) => ({
  label: null,
  cards: CARD_NAMES.map((name, i) => ({
    name: CARD_NAMES[(i + offset) % 8],
    level: 14,
    evolutionLevel: null,
    iconUrl: 'https://api-assets.clashroyale.com/cards/' + i + '.png',
    hasImage: true,
  })),
})
/** Compact fixture shorthand → MonitorResult / WidgetResult (both share the same safe fields). */
const expandResult = (spec) => {
  const n = spec.n ?? 1
  const base = {
    id: uuid(n + 10),
    timestamp: minutesAgo(spec.minutesAgo ?? 0),
    searchMode: 'fast',
    deckMode: spec.deckMode ?? 'pol',
    searchedNickname: spec.nick ?? spec.name ?? null,
    reprocessed: spec.reprocessed === true,
    capturePolicy: 'immediate_nickname',
    sessionId: null,
    triggerId: uuid(n + 100),
    attemptId: uuid(n + 200),
    profileId: uuid(1),
    calibrationRevision: 1,
    repeat:
      spec.repeatMinutesAgo === undefined
        ? null
        : {
            previousAt: minutesAgo(spec.repeatMinutesAgo),
            previousResultId: uuid(n + 300),
            localDay: '2026-10-10',
          },
  }
  switch (spec.kind ?? 'found') {
    case 'found':
      return {
        ...base,
        kind: 'player_found',
        player: {
          name: spec.name ?? 'Voron_17',
          tag: spec.tag === undefined ? '#2Q8YLP0' : spec.tag,
          rating: spec.rating === undefined ? 2487 : spec.rating,
          clan: spec.clan === undefined ? 'Северный ветер' : spec.clan,
        },
        decks: Array.from({ length: spec.decks ?? 3 }, (_, i) => expandDeck(i)),
      }
    case 'notfound':
      return { ...base, kind: 'player_not_found', message: 'Игрок не найден' }
    case 'recfail':
      return { ...base, kind: 'recognition_failed', message: 'Ник не прочитан' }
    default:
      return {
        ...base,
        kind: 'service_error',
        message: 'Сервис недоступен',
        retryable: true,
        authBlocked: false,
      }
  }
}
const expandSearch = (spec) => ({
  triggerId: uuid(111),
  attemptId: uuid(211),
  profileId: uuid(1),
  calibrationRevision: 1,
  phase: spec.phase ?? 'requesting',
  startedAt: minutesAgo(0),
  searchedNickname: spec.nick ?? null,
  retryExpiresAt: spec.retry ? new Date(now + 90_000).toISOString() : null,
})
const expandSummary = (spec) => ({
  sessionId: uuid(900),
  userId: 'u1',
  initialProfileId: uuid(1),
  startedAt: minutesAgo(spec.startedMinutesAgo ?? 134),
  endedAt: minutesAgo(0),
  stopReason: 'user',
  durationMs: (spec.startedMinutesAgo ?? 134) * 60_000,
  stats,
  repeatEncounters: 3,
  distinctRepeatedOpponents: 2,
})
const mstate = fixture.monitorState ?? 'READY'
const monitor = {
  state: mstate,
  preferences: { deckMode: 'pol' },
  readiness: {
    authenticated: true,
    captureConfigured: !fixture.noProfiles,
    sourceAvailable: !fixture.sourceMissing,
  },
  error: fixture.error ?? null,
  startedAt: new Date(now - 751000).toISOString(),
  stats,
  results: (fixture.results ?? []).map(expandResult),
  runIntent: mstate !== 'STOPPED',
  search: fixture.search ? expandSearch(fixture.search) : null,
  session: null,
  summary: fixture.summary ? expandSummary(fixture.summary) : null,
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

const widgetView = (spec) => {
  const width = spec.width ?? 360
  const compact = spec.compact === true
  return {
    settings: {
      autoOpen: true,
      alwaysOnTop: spec.pinned !== false,
      locked: spec.locked === true,
      opacity: 1,
      displayMode: 'detailed',
      bounds: { x: null, y: null, width, height: 360 },
      normalWidth: compact ? 360 : width,
      compactWidth: compact ? width : 520,
      compactMode: compact,
    },
    visible: true,
    result: spec.result ? expandResult(spec.result) : null,
    monitorState: spec.monitorState ?? 'READY',
    monitorError: spec.monitorError ?? null,
    runIntent: spec.runIntent ?? true,
    search: spec.search ? expandSearch(spec.search) : null,
    scale: Math.max(0.86, Math.min(1.5, width / 360)),
  }
}
const widgetApi = {
  rendererReady: ok(undefined),
  getView: ok(widgetView(fixture.widget ?? {})),
  onViewChanged: () => () => undefined,
  getCardAsset: cardAsset,
  updateSettings: () => Promise.resolve(widgetView(fixture.widget ?? {}).settings),
  hide: ok({}),
  copyPlayerTag: ok({ copied: true }),
}
if (fixture.widget) contextBridge.exposeInMainWorld('crToolsWidget', widgetApi)

const h2hLookup = ({ requestId }) => {
  const mode = fixture.h2h ?? 'ok'
  if (mode === 'loading') return new Promise(() => undefined)
  if (mode === 'unavailable')
    return Promise.resolve({
      capability: 'unavailable',
      requestId,
      retryAt: null,
      code: 'H2H_REQUEST_FAILED',
    })
  const none = {
    meetings: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    decisiveMeetings: 0,
    winRate: null,
  }
  const day = 86_400_000
  const base = {
    status: mode,
    opponent: { tag: '#2Q8YLP0', name: null },
    scope: 'recorded_path_of_legends',
    coverage: { source: 'cr_stats_current_and_archives', complete: true },
    updatedAt: new Date(now).toISOString(),
    stale: false,
  }
  const data =
    mode === 'ok'
      ? {
          ...base,
          totals: {
            meetings: 4,
            wins: 3,
            losses: 1,
            draws: 0,
            decisiveMeetings: 4,
            winRate: 75,
          },
          last: {
            at: new Date(now - day).toISOString(),
            result: 'win',
            accountTag: '#88299RC9Y',
          },
          recent: [
            {
              at: new Date(now - day).toISOString(),
              result: 'win',
              accountTag: '#88299RC9Y',
            },
            {
              at: new Date(now - 5 * day).toISOString(),
              result: 'loss',
              accountTag: '#22LUPYCYC',
            },
            {
              at: new Date(now - 8 * day).toISOString(),
              result: 'win',
              accountTag: '#88299RC9Y',
            },
            {
              at: new Date(now - 12 * day).toISOString(),
              result: 'win',
              accountTag: '#88299RC9Y',
            },
          ],
          perAccount: [
            {
              accountTag: '#88299RC9Y',
              alias: 'Основной',
              meetings: 3,
              wins: 3,
              losses: 0,
              draws: 0,
              decisiveMeetings: 3,
              winRate: 100,
              lastAt: new Date(now - day).toISOString(),
              lastResult: 'win',
            },
            {
              accountTag: '#22LUPYCYC',
              alias: 'Твинк',
              meetings: 1,
              wins: 0,
              losses: 1,
              draws: 0,
              decisiveMeetings: 1,
              winRate: 0,
              lastAt: new Date(now - 5 * day).toISOString(),
              lastResult: 'loss',
            },
          ],
        }
      : { ...base, totals: none, last: null, recent: [], perAccount: [] }
  return Promise.resolve({ capability: 'supported', requestId, data })
}

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
  getMonitorHistory: ok((fixture.history ?? []).map(expandResult)),
  updateMonitorPreferences: (preferences) => Promise.resolve(preferences),
  retryMonitorSearch: ok(monitor),
  getCardAsset: cardAsset,
  copyPlayerTag: ok({ copied: true }),
  showWidget: ok({}),
  h2h: { lookup: h2hLookup, cancel: ok(undefined) },
})
