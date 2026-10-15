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
const profile = (n, name, label, kind, active, health, extra = {}) => ({
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
  ...extra,
})
const healthProfiles = [
  profile(1, 'Основной', 'BlueStacks App Player', 'window', true, 'available'),
  profile(2, 'Для друзей', 'LDPlayer', 'window', false, 'missing'),
  profile(3, 'Планшет (Duo)', 'Экран 2', 'display', false, 'unknown', {
    resultConfigured: true,
  }),
  profile(4, 'Старый импорт', 'Game', 'window', false, 'metadata_unavailable', {
    calibrationHealth: 'needs_validation',
  }),
  profile(5, 'Два окна', 'MEmu Play', 'window', false, 'ambiguous', {
    calibrationHealth: 'imported',
  }),
]
const profiles = fixture.noProfiles
  ? { revision: null, activeProfileId: null, profiles: [] }
  : fixture.profilesMode === 'health'
    ? { revision: 3, activeProfileId: uuid(1), profiles: healthProfiles }
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
  geometry: fixture.geometry ?? null,
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
      compactWidth: compact ? width : 300,
      compactMode: compact,
    },
    visible: true,
    result: spec.result ? expandResult(spec.result) : null,
    monitorState: spec.monitorState ?? 'READY',
    monitorError: spec.monitorError ?? null,
    runIntent: spec.runIntent ?? true,
    search: spec.search ? expandSearch(spec.search) : null,
    sourceMinimized: spec.sourceMinimized === true,
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
  if (mode === 'ok' && fixture.h2hDetail) {
    const one = fixture.h2hDetail === 'one'
    const at = new Date(now - day).toISOString()
    const owners = [
      { tag: '#88299RC9Y', name: 'Основной · Путь легенд', wins: 3, losses: 1, draws: 1 },
      {
        tag: '#22LUPYCYC',
        name: 'Второй аккаунт с очень длинным названием',
        wins: 2,
        losses: 1,
        draws: 0,
      },
      { tag: '#YQP', name: '', wins: 0, losses: 0, draws: 0 },
    ].slice(0, one ? 1 : 3)
    const opponents = [
      { tag: '#2Q8YLP0', name: 'Voron_17 · основной', wins: 3, losses: 1, draws: 1 },
      {
        tag: '#PQL',
        name: 'Voron_17 · второй аккаунт с длинным именем',
        wins: 2,
        losses: 1,
        draws: 0,
      },
      { tag: '#LQP', name: null, wins: 0, losses: 0, draws: 0 },
    ].slice(0, one ? 1 : 3)
    const aggregates = (account) => ({
      wins: account.wins,
      losses: account.losses,
      draws: account.draws,
      total: account.wins + account.losses + account.draws,
      decisiveMeetings: account.wins + account.losses,
      winRate:
        account.wins + account.losses
          ? (account.wins * 100) / (account.wins + account.losses)
          : null,
      lastAt: account.wins + account.losses + account.draws ? at : null,
    })
    data.perAccount = owners.map((account) => ({
      accountTag: account.tag,
      alias: account.name,
      ...aggregates(account),
      meetings: aggregates(account).total,
      lastResult: account.wins ? 'win' : null,
    }))
    data.perOpponentAccount = opponents.map((account) => ({
      tag: account.tag,
      name: account.name,
      ...aggregates(account),
    }))
    data.pairs = owners
      .filter((account) => account.wins > 0)
      .map((account, index) => ({
        ownerTag: account.tag,
        ownerName: account.name,
        opponentTag: opponents[index].tag,
        opponentName: opponents[index].name,
        wins: account.wins,
        losses: account.losses,
        draws: account.draws,
        total: aggregates(account).total,
        lastAt: at,
      }))
    data.totals = {
      meetings: one ? 5 : 8,
      wins: one ? 3 : 5,
      losses: one ? 1 : 2,
      draws: 1,
      decisiveMeetings: one ? 4 : 7,
      winRate: one ? 75 : 71.4,
    }
    data.recent = ['win', 'loss', 'draw', 'win'].map((result, index) => ({
      at: new Date(now - (index + 1) * day).toISOString(),
      result,
      accountTag: owners[one ? 0 : index % 2].tag,
      ownerTag: owners[one ? 0 : index % 2].tag,
      opponentTag: opponents[one ? 0 : index % 2].tag,
    }))
    data.last = data.recent[0]
  }
  return Promise.resolve({ capability: 'supported', requestId, data })
}

// ── M4: capture sources, profile commands and a setup session that follows main's rules ──
const setupFx = fixture.setup ?? {}
const canvasOf = (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
const roundRect = (g, x, y, w, h, r, fill) => {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
  g.fillStyle = fill
  g.fill()
}
// A stand-in for a captured game window: dark pillarbox, portrait game area.
const drawGame = (c, scene) => {
  const g = c.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, c.width, c.height)
  const gw = c.height * 0.5625
  const gx = (c.width - gw) / 2
  const grad = g.createLinearGradient(0, 0, 0, c.height)
  grad.addColorStop(0, '#26304a')
  grad.addColorStop(1, '#141a2a')
  g.fillStyle = grad
  g.fillRect(gx, 0, gw, c.height)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const plate = (fy, text, fill, ink) => {
    roundRect(
      g,
      gx + gw * 0.12,
      c.height * fy,
      gw * 0.76,
      c.height * 0.1,
      gw * 0.03,
      fill,
    )
    g.fillStyle = ink
    g.font = `600 ${gw * 0.075}px "Segoe UI"`
    g.fillText(text, gx + gw * 0.5, c.height * (fy + 0.05))
  }
  if (scene === 'result') {
    g.fillStyle = '#f4f5f7'
    g.font = `800 ${gw * 0.12}px "Segoe UI"`
    g.fillText('ПОБЕДА', gx + gw * 0.5, c.height * 0.18)
    roundRect(
      g,
      gx + gw * 0.1,
      c.height * 0.3,
      gw * 0.8,
      c.height * 0.2,
      gw * 0.03,
      '#2c3652',
    )
    roundRect(
      g,
      gx + gw * 0.1,
      c.height * 0.56,
      gw * 0.8,
      c.height * 0.14,
      gw * 0.03,
      '#242d46',
    )
    plate(0.78, 'Продолжить', '#3d66c7', '#f4f5f7')
  } else if (scene === 'menu') {
    roundRect(
      g,
      gx + gw * 0.08,
      c.height * 0.04,
      gw * 0.84,
      c.height * 0.05,
      gw * 0.02,
      '#2a3552',
    )
    roundRect(
      g,
      gx + gw * 0.08,
      c.height * 0.13,
      gw * 0.84,
      c.height * 0.3,
      gw * 0.04,
      '#2c3652',
    )
    plate(0.68, 'Бой', '#3d66c7', '#f4f5f7')
  } else {
    plate(0.15, 'Voron_17', '#38435f', '#e9eaec')
    g.fillStyle = '#f4f5f7'
    g.font = `italic 800 ${gw * 0.3}px "Segoe UI"`
    g.fillText('VS', gx + gw * 0.5, c.height * 0.49)
    plate(0.76, 'ArtCS', '#2a3552', '#9b9ea7')
  }
}
const sceneFrame = (scene, w = 1280, h = 720) => {
  const c = canvasOf(w, h)
  drawGame(c, scene)
  return c
}
const sourceDefs = [
  ['a', 'window', 'BlueStacks App Player', 'HD-Player.exe', true, 'menu'],
  ['b', 'window', 'LDPlayer', 'dnplayer.exe', true, 'menu'],
  ['c', 'window', 'MEmu Play', 'MEmu.exe', true, 'menu'],
  ['d', 'window', 'Диспетчер задач', 'Taskmgr.exe', false, 'menu'],
  ['e', 'display', 'Экран 1', '2560 × 1440 · основной', true, 'menu'],
  ['f', 'display', 'Экран 2', '1920 × 1080', true, 'menu'],
]
const sourceRevision = 'c'.repeat(32)
const sourceSnapshot = (withPreviews) => ({
  revision: sourceRevision,
  expiresAt: now + 3_600_000,
  sources: sourceDefs.map(([key, kind, label, detail, supported, scene]) => ({
    sourceKey: key.repeat(32),
    revision: sourceRevision,
    kind,
    label,
    detail: supported ? detail : null,
    captureSupported: supported,
    unavailableReason: supported ? null : 'Окно нельзя захватить',
    preview:
      withPreviews && supported
        ? {
            size: { width: 320, height: 200 },
            dataUrl: sceneFrame(scene, 320, 200).toDataURL('image/jpeg', 0.7),
          }
        : null,
  })),
})
const gameX = (f) => (437 + f * 405) / 1280
const gameW = (f) => (f * 405) / 1280
const REGIONS = {
  trigger: { x: gameX(0.28), y: 0.4, width: gameW(0.44), height: 0.18 },
  nickname: { x: gameX(0.12), y: 0.15, width: gameW(0.76), height: 0.1 },
  topLeftEvidence: { x: gameX(0.04), y: 0.02, width: gameW(0.5), height: 0.1 },
  resultTrigger: { x: gameX(0.12), y: 0.1, width: gameW(0.76), height: 0.16 },
  resultData: { x: gameX(0.1), y: 0.3, width: gameW(0.8), height: 0.2 },
}
const triggerProfileFx = (grade) => ({
  schemaVersion: 3,
  analyzer: { name: 'cr-tools-trigger-analyzer', version: '2.0.0' },
  innerRect: { x: 0.12, y: 0.18, width: 0.76, height: 0.64 },
  structureAlgorithm: 'max-channel-scharr-v1',
  structureHash64: '0123456789abcdef',
  matcherMode: 'edge_orb',
  normalizedTemplateSize: { width: 128, height: 128 },
  structureTemplateBase64: 'dGVzdA==',
  edgeTemplateBase64: 'dGVzdA==',
  orientationTemplateBase64: 'dGVzdA==',
  quality: {
    grade,
    score: grade === 'high' ? 0.96 : 0.71,
    edgePixelCount: 512,
    edgeCoverage: 0.75,
    keypointsCount: 12,
    cropConfidence: 0.9,
    cropAreaRatio: 0.64,
  },
})
const emptyRegions = {
  trigger: null,
  nickname: null,
  topLeftEvidence: null,
  resultTrigger: null,
  resultData: null,
}
// `setup.game: true`: main found the game in the frozen frame (portrait area of the stand-in).
const gameFx = () => ({
  viewport: { x: 437.5 / 1280, y: 0, width: 405 / 1280, height: 1 },
  aspect: 0.5625,
  source: 'freeze',
})
const runningDetectionFx = (startedAgoMs) => ({
  status: 'running',
  phase: 'waiting_vs',
  startedAt: new Date(Date.now() - startedAgoMs).toISOString(),
  deadlineAt: new Date(Date.now() - startedAgoMs + 60_000).toISOString(),
  game: null,
  failure: null,
  frameAvailable: false,
  nameCheck: { status: 'pending', text: null },
})
const detectingSession = (name, patch) =>
  makeSession('capture', name, {
    generation: 0,
    state: 'DETECTING',
    frameSize: null,
    game: null,
    detection: runningDetectionFx(13_000),
    ...patch,
  })
const makeSession = (kind, name, patch = {}) => ({
  kind,
  sessionId: uuid(901),
  generation: 1,
  state: 'SELECTING',
  source: {
    kind: 'window',
    label: 'BlueStacks App Player',
    executableName: 'HD-Player.exe',
  },
  profileId: uuid(7),
  profileName: name,
  frameSize: { width: 1280, height: 720 },
  game: setupFx.game && kind === 'capture' ? gameFx() : null,
  triggerKind: null,
  regionOrigins: null,
  regions: { ...emptyRegions },
  triggerProfile: null,
  error: null,
  saveOutcome: null,
  ...patch,
})
const initialSession = () => {
  const mode = setupFx.session
  const capture = {
    trigger: REGIONS.trigger,
    nickname: REGIONS.nickname,
    topLeftEvidence: REGIONS.topLeftEvidence,
  }
  const grade = setupFx.grade ?? 'high'
  if (mode === 'selecting') return makeSession('capture', 'Ноутбук')
  if (mode === 'regions')
    return makeSession('capture', 'Ноутбук', { regions: { ...emptyRegions, ...capture } })
  if (mode === 'checked')
    return makeSession('capture', 'Ноутбук', {
      regions: { ...emptyRegions, ...capture },
      triggerProfile: triggerProfileFx(grade),
    })
  if (mode === 'result') return makeSession('predictionResult', 'Основной')
  if (mode === 'resultRegions')
    return makeSession('predictionResult', 'Основной', {
      regions: {
        ...emptyRegions,
        resultTrigger: REGIONS.resultTrigger,
        resultData: REGIONS.resultData,
      },
    })
  if (mode === 'detecting') return detectingSession('Ноутбук', {})
  if (mode === 'detectFailed')
    return detectingSession('Ноутбук', {
      generation: 1,
      detection: {
        ...runningDetectionFx(60_000),
        status: 'failed',
        failure: { code: setupFx.autoCode ?? 'AUTO_VS_TIMEOUT' },
      },
    })
  if (mode === 'detected')
    return makeSession('capture', 'Ноутбук', {
      generation: 2,
      game: { ...gameFx(), source: 'auto' },
      regionOrigins: { trigger: 'auto', nickname: 'auto', topLeftEvidence: 'auto' },
      triggerKind: 'vs_edge_orientation',
      triggerOutline: [
        [gameX(0.36), 0.425],
        [gameX(0.5), 0.415],
        [gameX(0.64), 0.425],
        [gameX(0.62), 0.5],
        [gameX(0.5), 0.565],
        [gameX(0.38), 0.5],
      ],
      regions: { ...emptyRegions, ...capture },
      triggerProfile: triggerProfileFx('high'),
      detection: {
        ...runningDetectionFx(5_000),
        status: 'succeeded',
        phase: null,
        game: { viewport: gameFx().viewport, aspect: 0.5625 },
        frameAvailable: true,
        nameCheck: { status: 'trainer', text: 'Тренер Чеддер' },
      },
    })
  if (mode === 'failed')
    return makeSession('capture', 'Ноутбук', {
      state: 'FAILED',
      frameSize: null,
      error: { code: setupFx.failCode ?? 'CAPTURE_NO_FRAME', message: 'No frame' },
    })
  return null
}
let session = initialSession()
let startedOnce = false
const frameScene = () =>
  session && session.kind === 'predictionResult' ? 'result' : 'vs'
const bump = (patch) => {
  session = { ...session, generation: session.generation + 1, ...patch }
  return session
}
const requireSession = (payload) => {
  if (session === null) return Promise.reject(new Error('No setup is active'))
  if (payload.sessionId !== session.sessionId)
    return Promise.reject(new Error('Setup session is stale'))
  if (payload.generation !== session.generation)
    return Promise.reject(new Error('Setup command is stale'))
  return null
}
const commitOutcome = () => ({
  local: setupFx.local ?? 'saved',
  projection: setupFx.projection ?? 'synced',
  runtime: setupFx.runtime ?? 'ready',
  warning:
    (setupFx.projection ?? 'synced') === 'failed'
      ? 'SETUP_SYNC_FAILED'
      : (setupFx.runtime ?? 'ready') === 'failed'
        ? 'SETUP_RUNTIME_FAILED'
        : null,
})
const setupApi = {
  getSession: () =>
    session === null
      ? Promise.reject(new Error('No setup is active'))
      : Promise.resolve(session),
  getFrame: async (payload) => {
    const refused = requireSession(payload)
    if (refused !== null) return refused
    const blob = await new Promise((resolve) =>
      sceneFrame(frameScene()).toBlob(resolve, 'image/png'),
    )
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return {
      sessionId: session.sessionId,
      generation: session.generation,
      size: { width: 1280, height: 720 },
      byteLength: bytes.byteLength,
      mimeType: 'image/png',
      bytes,
    }
  },
  setRegion: (payload) =>
    requireSession(payload) ??
    Promise.resolve(
      bump({
        regions: { ...session.regions, [payload.region]: payload.rect },
        ...(payload.region === 'trigger' || payload.region === 'resultTrigger'
          ? { triggerProfile: null }
          : {}),
        error: null,
      }),
    ),
  analyzeTrigger: (payload) =>
    requireSession(payload) ??
    Promise.resolve(
      bump({ triggerProfile: triggerProfileFx(setupFx.grade ?? 'high'), error: null }),
    ),
  review: (payload) =>
    requireSession(payload) ?? Promise.resolve(bump({ state: 'REVIEW' })),
  commit: (payload) =>
    requireSession(payload) ??
    Promise.resolve(
      setupFx.commitError
        ? bump({
            state: 'REVIEW',
            error: { code: setupFx.commitError, message: 'refused' },
          })
        : bump({ state: 'COMMITTED', saveOutcome: commitOutcome() }),
    ),
  retrySync: (payload) =>
    requireSession(payload) ??
    Promise.resolve(
      bump({
        saveOutcome: { ...session.saveOutcome, projection: 'synced', warning: null },
      }),
    ),
  cancel: (payload) =>
    requireSession(payload) ?? Promise.resolve(bump({ state: 'CANCELLED' })),
  close: (payload) => requireSession(payload) ?? Promise.resolve(session),
  finish: fail,
  // Automatic setup (M9 B3): the stand-in window picture, a retry and the manual switch.
  getDetectionPreview: async (payload) => {
    const refused = requireSession({ ...payload, generation: session?.generation })
    if (refused !== null) return refused
    const blob = await new Promise((resolve) =>
      sceneFrame('menu', 640, 360).toBlob(resolve, 'image/jpeg', 0.7),
    )
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return {
      width: 640,
      height: 360,
      mimeType: 'image/jpeg',
      byteLength: bytes.byteLength,
      bytes,
    }
  },
  retryDetection: (payload) =>
    requireSession(payload) ??
    Promise.resolve(bump({ detection: runningDetectionFx(0) })),
  switchToManual: (payload) =>
    requireSession(payload) ??
    Promise.resolve(
      bump({
        state: 'SELECTING',
        frameSize: { width: 1280, height: 720 },
        game: gameFx(),
        regionOrigins: {
          trigger: 'manual',
          nickname: 'manual',
          topLeftEvidence: 'manual',
        },
      }),
    ),
  startResult: () => {
    session = makeSession('predictionResult', 'Основной')
    return Promise.resolve(session)
  },
}
const profileMutation = () => ({
  ok: true,
  profiles,
  monitor,
  capture: {
    configured: true,
    revision: profiles.revision,
    sourceLabel: 'BlueStacks App Player',
  },
})
const renameProfile = ({ profileId, profileName }) => {
  profiles.profiles = profiles.profiles.map((p) =>
    p.profileId === profileId ? { ...p, profileName } : p,
  )
  profiles.revision += 1
  return Promise.resolve(profileMutation())
}

// ── M5: streamer area, widget settings and the auth window ───────────────────────────
const sx = fixture.streamer ?? {}
const accountRows = [
  {
    tag: '#88299RC9Y',
    name: 'ArtCS',
    alias: 'Основной',
    enabled: true,
    currentRank: 297,
    currentElo: 2675,
  },
  {
    tag: '#22LUPYCYC',
    name: 'artcs_two',
    alias: 'Твинк',
    enabled: true,
    currentRank: 1904,
    currentElo: 2411,
  },
  {
    tag: '#9PQ0L2YVV',
    name: 'ArtCS_old',
    alias: 'Запасной',
    enabled: false,
    currentRank: null,
    currentElo: null,
  },
]
const titleTemplates = {
  full: '{rank} · {elo} · {wins}W-{losses}L · {delta}',
  chips: '{rank} · {elo} · {wins}W-{losses}L | Играю в Clash Royale',
  raw: '{rank} !! особый {elo}',
}
const renderTitle = (template) =>
  template
    .replaceAll('{rank}', '★ 297')
    .replaceAll('{elo}', '2 675 ELO')
    .replaceAll('{wins}W-{losses}L', '5W-2L')
    .replaceAll('{delta}', '+12')
    .replaceAll('{account}', 'Основной')
const twitchOn = (sx.twitch ?? 'on') === 'on'
const sview = {
  access: { allowed: true, reason: null },
  twitch: {
    connected: twitchOn,
    username: twitchOn ? 'artcs_cr' : null,
    polling: sx.twitch === 'pending',
  },
  predictions: {
    active: sx.predictions === 'active' || sx.predictions === 'suspended',
    state:
      sx.predictions === 'active' || sx.predictions === 'suspended'
        ? 'active'
        : 'stopped',
    runtimeState:
      sx.predictions === 'active'
        ? 'active'
        : sx.predictions === 'suspended'
          ? 'suspended'
          : sx.predictions === 'failed'
            ? 'failed'
            : 'stopped',
    settings: {
      predictionType: 'win_lose',
      predictionWindow: 120,
      winStreakCount: 3,
      delayBetweenPredictions: 10,
      autoCreateNext: true,
    },
    statistics: {
      total: 24,
      successful: 18,
      successRate: 75,
      currentWinStreak: 3,
      activeTitle: sx.predictions === 'active' ? 'Победит ли стример в этом бою?' : null,
    },
    requirements: {
      twitchConnected: twitchOn,
      mainMonitorConfigured: true,
      mainMonitorRunning: true,
      resultConfigured: sx.zones !== false,
    },
  },
  title: {
    settings: {
      enabled: sx.titleOn === true,
      paused: false,
      prefixTemplate: titleTemplates[sx.title ?? 'full'],
      wlMode: 'active',
      accountDisplayMode: 'last_active',
      manualAccountTag: '',
      includeRank: true,
      includeElo: true,
      includeWl: true,
      includeDelta: (sx.title ?? 'full') === 'full',
      maxAccounts: 3,
      pollIntervalSeconds: 5,
      twitchCheckIntervalSeconds: 30,
      offlineGraceMinutes: 5,
      battleMode: 'pathOfLegend',
      restoreTitleOnOffline: true,
    },
    accounts: accountRows.slice(0, sx.accounts ?? 3),
    session: { totalWins: 5, totalLosses: 2, activeAccountTag: '#88299RC9Y' },
    recentResults: ['win', 'loss', 'win', 'win', 'loss', 'win', 'win'].map((result) => ({
      result,
      accountTag: '#88299RC9Y',
      at: null,
    })),
    previewTitle: renderTitle(titleTemplates[sx.title ?? 'full']),
    twitchOnline: true,
  },
  deckSharing: { enabled: sx.chat !== false },
  overlay: {
    settings: {
      enabled: sx.widgetsOn !== false,
      opponentEnabled: sx.widgetsOn !== false,
      streamerStatsEnabled: sx.widgetsOn !== false,
      previewMode: sx.previewMode === true,
      previewTarget: 'both',
      streamerAccountMode: 'stream_title',
      manualStreamerTag: '',
      recentLimit: 5,
      opponentDisplaySeconds: 30,
      opponentSlideSeconds: 10,
      opponentSecondSlideEnabled: false,
      opponentTransitionMs: 400,
      statsMainSeconds: 20,
      statsDeltaSeconds: 5,
      statsBetweenSeconds: 2,
      statsPollMs: 1000,
      statsTransitionMs: 400,
      statsLayout: 'standard',
      opponentLayout: 'standard',
      widgetFontStyle: 'gaming',
      widgetCornerStyle: 'rounded',
      matchupEnabled: false,
      matchupRankLimits: [100],
      matchupMinGames: 5,
    },
    urlsAvailable: { stats: sx.urls !== false, opponent: sx.urls !== false },
    maskedUrls: {
      stats:
        sx.urls === false ? null : 'api.artcsworld.xyz/streamer-stats-widget?key=••••••',
      opponent:
        sx.urls === false ? null : 'api.artcsworld.xyz/opponent-widget?key=••••••',
    },
    recommendedSizes: { stats: '480x64', opponent: '560x380' },
  },
  refresh: {
    state: sx.partial ? 'partial' : 'ready',
    errors: sx.partial
      ? [
          {
            section: 'twitch',
            error: { code: 'NETWORK_UNAVAILABLE', message: 'Нет связи' },
          },
        ]
      : [],
    refreshedAt: '2026-10-10T12:00:00.000Z',
  },
}
const sreadiness = () => ({
  twitchConnected: sview.twitch.connected,
  accountsCount: sview.title.accounts.filter((a) => a.enabled).length,
  monitoring: sx.monitoring !== false,
  captureConfigured: sx.profile !== false,
  resultZonesConfigured: sx.zones !== false,
  activeProfileId: uuid(1),
})
const sclone = () => JSON.parse(JSON.stringify(sview))
const sok = (extra = {}) => ({
  ok: true,
  view: sclone(),
  preview: null,
  warnings: [],
  titleApplication: 'not_requested',
  ...extra,
})
const PRESET_CHIPS = {
  short: ['rank', 'elo'],
  score: ['elo', 'wl'],
  full: ['rank', 'elo', 'wl', 'delta'],
  signed: ['rank', 'elo', { text: 'Играю в Clash Royale' }],
}
const TOKENS = {
  rank: '{rank}',
  elo: '{elo}',
  wl: '{wins}W-{losses}L',
  delta: '{delta}',
  account: '{account}',
  best: '{account}',
}
const compileBuilder = (settings, builder) => {
  if (builder.mode === 'raw') return { ...settings, prefixTemplate: builder.template }
  const chips =
    builder.mode === 'preset'
      ? PRESET_CHIPS[builder.preset].map((c) =>
          typeof c === 'string' ? { kind: c } : { kind: 'text', ...c },
        )
      : builder.chips
  const data = chips.filter((c) => c.kind !== 'text').map((c) => TOKENS[c.kind])
  const text = chips.filter((c) => c.kind === 'text' && c.text).map((c) => c.text)
  const kinds = new Set(chips.map((c) => c.kind))
  return {
    ...settings,
    prefixTemplate: [data.join(' · '), text.join(' ')].filter(Boolean).join(' | '),
    includeRank: kinds.has('rank'),
    includeElo: kinds.has('elo'),
    includeWl: kinds.has('wl'),
    includeDelta: kinds.has('delta'),
  }
}
const streamerCommand = (command) => {
  const settings = sview.title.settings
  switch (command.action) {
    case 'chat.toggle':
      sview.deckSharing.enabled = command.enabled
      return Promise.resolve(sok())
    case 'title.enabled':
      settings.enabled = command.enabled
      return Promise.resolve(sok())
    case 'title.paused':
      settings.paused = command.paused
      return Promise.resolve(sok())
    case 'title.save':
    case 'title.apply':
      sview.title.settings = command.settings
      sview.title.previewTitle = renderTitle(command.settings.prefixTemplate)
      return Promise.resolve(
        command.action === 'title.apply'
          ? sok({
              titleApplication: 'unconfirmed',
              warnings: ['TITLE_APPLICATION_UNCONFIRMED'],
            })
          : sok(),
      )
    case 'title.preview': {
      const text = renderTitle(command.settings.prefixTemplate)
      return Promise.resolve(
        sok({
          preview: { previewTitle: text, characterCount: text.length, warnings: [] },
        }),
      )
    }
    case 'widget.settings':
      sview.overlay.settings = command.settings
      return Promise.resolve(sok())
    case 'predictions.start':
      sview.predictions.active = true
      sview.predictions.runtimeState = 'active'
      return Promise.resolve(sok())
    case 'predictions.stop':
      sview.predictions.active = false
      sview.predictions.runtimeState = 'stopped'
      return Promise.resolve(sok())
    case 'accounts.add':
      if (sx.accountError)
        return Promise.resolve({
          ok: false,
          error: { code: sx.accountError, detail: null },
        })
      sview.title.accounts.push({
        tag: command.tag,
        name: command.alias || command.tag,
        alias: command.alias,
        enabled: true,
        currentRank: null,
        currentElo: null,
      })
      return Promise.resolve(sok())
    case 'twitch.disconnect':
      sview.twitch = { connected: false, username: null, polling: false }
      return Promise.resolve(sok())
    default:
      return Promise.resolve(sok())
  }
}
const streamerApi = {
  command: streamerCommand,
  getReadiness: () => Promise.resolve(sreadiness()),
  compileTitle: ({ settings, builder }) =>
    Promise.resolve({ ok: true, settings: compileBuilder(settings, builder) }),
  decompileTitle: () =>
    Promise.resolve(
      sx.title === 'raw'
        ? { mode: 'raw', template: titleTemplates.raw }
        : sx.title === 'chips'
          ? {
              mode: 'chips',
              chips: [
                { kind: 'rank' },
                { kind: 'elo' },
                { kind: 'wl' },
                { kind: 'text', text: 'Играю в Clash Royale' },
              ],
            }
          : { mode: 'preset', preset: 'full' },
    ),
}
const widgetStatus = {
  visible: fixture.widgetVisible === true,
  hasResult: false,
  settings: {
    autoOpen: true,
    alwaysOnTop: true,
    locked: false,
    opacity: 0.9,
    displayMode: 'detailed',
    bounds: { x: null, y: null, width: 360, height: 300 },
    normalWidth: 360,
    compactWidth: 300,
    compactMode: false,
  },
}
const streamerFailing = sx.loadFail === true

if (fixture.authWindow) {
  const auth = fixture.authWindow
  let mode = auth.view
  const reply = () => Promise.resolve(mode)
  contextBridge.exposeInMainWorld('crToolsAuth', {
    getView: () => (auth.hang ? new Promise(() => undefined) : Promise.resolve(mode)),
    retryBootstrap: reply,
    resetLogin: reply,
    login: reply,
    register: reply,
    getUpdateView: ok(auth.update ?? data.update),
    checkForUpdate: ok(auth.update ?? data.update),
    downloadUpdate: () => new Promise(() => undefined),
    cancelUpdate: ok(auth.update ?? data.update),
    installUpdate: ok(auth.update ?? data.update),
  })
}

contextBridge.exposeInMainWorld('crTools', {
  setup: setupApi,
  streamer: streamerApi,
  setStreamerSectionActive: () => (streamerFailing ? fail() : Promise.resolve(sclone())),
  getStreamerView: () => (streamerFailing ? fail() : Promise.resolve(sclone())),
  refreshStreamer: () => (streamerFailing ? fail() : Promise.resolve(sclone())),
  getWidgetStatus: ok(widgetStatus),
  updateWidgetSettings: (patch) =>
    Promise.resolve({ ...widgetStatus.settings, ...patch }),
  toggleWidget: ok({ ...widgetStatus, visible: true }),
  openLogFolder: ok({ opened: true }),
  updateAppSettings: (patch) => Promise.resolve({ ...data.settings, ...patch }),
  checkForUpdate: ok(data.update),
  downloadUpdate: ok(data.update),
  cancelUpdate: ok(data.update),
  installUpdate: ok(data.update),
  listCaptureSources: () => Promise.resolve(sourceSnapshot(false)),
  loadCapturePreviews: () => Promise.resolve(sourceSnapshot(true)),
  prepareCaptureSource: ({ sourceKey, revision }) =>
    Promise.resolve(
      setupFx.prepareError
        ? { ok: false, error: { code: setupFx.prepareError, message: 'failed' } }
        : { ok: true, preparation: { sourceKey, revision, preparationId: uuid(902) } },
    ),
  releaseCaptureSource: ok({ released: true }),
  startCaptureSetup: ({ mode, profileId, profileName }) => {
    if (mode === 'auto') {
      session = detectingSession(profileName, { profileId: profileId ?? uuid(7) })
      return Promise.resolve(session)
    }
    if (mode !== 'manual') return Promise.reject(new Error('Unknown setup mode'))
    // `start: 'failed-once'`: only the first frozen frame fails (a retake then works).
    const failing =
      setupFx.start === 'failed' || (setupFx.start === 'failed-once' && !startedOnce)
    startedOnce = true
    session = failing
      ? makeSession('capture', profileName, {
          state: 'FAILED',
          frameSize: null,
          error: { code: setupFx.failCode ?? 'CAPTURE_NO_FRAME', message: 'No frame' },
        })
      : makeSession('capture', profileName, { profileId: profileId ?? uuid(7) })
    return Promise.resolve(session)
  },
  renameCaptureProfile: renameProfile,
  duplicateCaptureProfile: ({ profileId, profileName }) => {
    const base = profiles.profiles.find((p) => p.profileId === profileId)
    profiles.profiles = [
      ...profiles.profiles,
      {
        ...base,
        profileId: uuid(40 + profiles.profiles.length),
        profileName,
        isActive: false,
      },
    ]
    profiles.revision += 1
    return Promise.resolve(profileMutation())
  },
  deleteCaptureProfile: ({ profileId }) => {
    profiles.profiles = profiles.profiles.filter((p) => p.profileId !== profileId)
    profiles.revision += 1
    return Promise.resolve(profileMutation())
  },
  rebindCaptureProfile: () => Promise.resolve(profileMutation()),
  activateCaptureProfile: ({ profileId }) => {
    profiles.profiles = profiles.profiles.map((p) => ({
      ...p,
      isActive: p.profileId === profileId,
    }))
    profiles.activeProfileId = profileId
    profiles.revision += 1
    return Promise.resolve(profileMutation())
  },
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
