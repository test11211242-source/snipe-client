import type {
  OverlaySettings,
  PredictionPreferences,
  StreamTitleSettings,
  StreamerView,
} from '../../../shared/models/streamer'

type RecordValue = Record<string, unknown>

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {}
const text = (value: unknown, fallback = '', max = 300): string =>
  typeof value === 'string' ? value.slice(0, max) : fallback
const bool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback
const integer = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback
const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
const choice = <T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T =>
  typeof value === 'string' && values.includes(value as T) ? (value as T) : fallback

export const DEFAULT_TITLE_SETTINGS: StreamTitleSettings = {
  enabled: false,
  paused: false,
  prefixTemplate: '[#{rank} & {elo} ({delta}) - {wins}W-{losses}L]',
  wlMode: 'active',
  accountDisplayMode: 'last_active',
  manualAccountTag: '',
  includeRank: true,
  includeElo: true,
  includeWl: true,
  includeDelta: true,
  maxAccounts: 1,
  pollIntervalSeconds: 2,
  twitchCheckIntervalSeconds: 15,
  offlineGraceMinutes: 10,
  battleMode: 'pathOfLegend',
  restoreTitleOnOffline: false,
}

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  enabled: false,
  opponentEnabled: true,
  streamerStatsEnabled: true,
  previewMode: false,
  previewTarget: 'both',
  streamerAccountMode: 'stream_title',
  manualStreamerTag: '',
  recentLimit: 10,
  opponentDisplaySeconds: 30,
  opponentSlideSeconds: 15,
  opponentSecondSlideEnabled: true,
  opponentTransitionMs: 550,
  statsMainSeconds: 15,
  statsDeltaSeconds: 5,
  statsBetweenSeconds: 4,
  statsPollMs: 1000,
  statsTransitionMs: 500,
  statsLayout: 'detailed',
  opponentLayout: 'detailed',
  widgetFontStyle: 'gaming',
  widgetCornerStyle: 'rounded',
  matchupEnabled: true,
  matchupRankLimits: [200, 500, 1000],
  matchupMinGames: 5,
}

export function parseTwitch(value: unknown): StreamerView['twitch'] {
  const input = record(value)
  return {
    connected: bool(input['connected']),
    username: bool(input['connected']) ? text(input['username'], '', 100) || null : null,
    polling: false,
  }
}

export function parsePredictions(
  value: unknown,
  settings: PredictionPreferences,
): Pick<StreamerView['predictions'], 'active' | 'state' | 'settings' | 'statistics'> {
  const status = record(record(value)['status'])
  const statistics = record(status['statistics'])
  const current = record(record(status['current_prediction'])['prediction'])
  return {
    active: bool(status['is_active']),
    state: text(status['state'], 'idle', 64),
    settings,
    statistics: {
      total: integer(statistics['total_predictions'], 0, 0, 1_000_000),
      successful: integer(statistics['successful_predictions'], 0, 0, 1_000_000),
      successRate: number(statistics['success_rate'], 0, 0, 100),
      currentWinStreak: integer(statistics['current_win_streak'], 0, 0, 1_000_000),
      activeTitle: text(current['title'], '', 200) || null,
    },
  }
}

export function parseTitle(value: unknown): StreamerView['title'] {
  const input = record(value)
  const settings = record(input['settings'])
  const twitch = record(input['twitch'])
  const session = record(input['session'])
  const rawAccounts = Array.isArray(input['accounts'])
    ? input['accounts'].slice(0, 4)
    : []
  const rawResults = Array.isArray(input['recent_results'])
    ? input['recent_results'].slice(0, 20)
    : []
  return {
    settings: {
      enabled: bool(settings['enabled']),
      paused: bool(settings['paused']),
      prefixTemplate: text(
        settings['prefix_template'],
        DEFAULT_TITLE_SETTINGS.prefixTemplate,
        200,
      ),
      wlMode: choice(settings['wl_mode'], ['active', 'total'], 'active'),
      accountDisplayMode: choice(
        settings['account_display_mode'],
        ['last_active', 'manual', 'best_elo', 'multiple'],
        'last_active',
      ),
      manualAccountTag: text(settings['manual_account_tag'], '', 20),
      includeRank: bool(settings['include_rank'], true),
      includeElo: bool(settings['include_elo'], true),
      includeWl: bool(settings['include_wl'], true),
      includeDelta: bool(settings['include_delta'], true),
      maxAccounts: integer(settings['max_accounts'], 1, 1, 4),
      pollIntervalSeconds: integer(settings['poll_interval_seconds'], 2, 2, 30),
      twitchCheckIntervalSeconds: integer(
        settings['twitch_check_interval_seconds'],
        15,
        10,
        120,
      ),
      offlineGraceMinutes: integer(settings['offline_grace_minutes'], 10, 1, 120),
      battleMode: choice(
        settings['battle_mode'],
        ['pathOfLegend', 'all'],
        'pathOfLegend',
      ),
      restoreTitleOnOffline: bool(settings['restore_title_on_offline']),
    },
    accounts: rawAccounts.map((item) => {
      const account = record(item)
      return {
        tag: text(account['tag'], '', 20),
        name: text(account['name'], '', 100),
        alias: text(account['alias'], '', 100),
        enabled: bool(account['enabled'], true),
        currentRank:
          typeof account['current_rank'] === 'number'
            ? integer(account['current_rank'], 1, 1, 1_000_000)
            : null,
        currentElo:
          typeof account['current_elo'] === 'number'
            ? integer(account['current_elo'], 0, 0, 100_000)
            : null,
      }
    }),
    session:
      Object.keys(session).length === 0
        ? null
        : {
            totalWins: integer(session['total_wins'], 0, 0, 1_000_000),
            totalLosses: integer(session['total_losses'], 0, 0, 1_000_000),
            activeAccountTag: text(session['active_account_tag'], '', 20) || null,
          },
    recentResults: rawResults.map((item) => {
      const result = record(item)
      return {
        result: choice(result['result'], ['win', 'loss', 'unknown'], 'unknown'),
        accountTag: text(result['account_tag'], '', 20) || null,
        at: text(result['created_at'] ?? result['updated_at'], '', 40) || null,
      }
    }),
    previewTitle: text(input['preview_title'] ?? input['default_template'], '', 300),
    twitchOnline: bool(twitch['online']),
  }
}

export interface ParsedOverlay {
  settings: OverlaySettings
  urls: { stats: string | null; opponent: string | null }
}

function obsPageUrl(value: unknown, pathname: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    const keys = [...url.searchParams.keys()]
    const token = url.searchParams.get('token')
    return url.protocol === 'https:' &&
      url.hostname === 'api.artcsworld.xyz' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === pathname &&
      url.hash === '' &&
      keys.length === 1 &&
      keys[0] === 'token' &&
      token !== null &&
      token.length >= 8
      ? url.href
      : null
  } catch {
    return null
  }
}

export function parseOverlay(value: unknown): ParsedOverlay {
  const input = record(value)
  const settings = record(input['settings'])
  const requestedRanks = Array.isArray(settings['matchup_rank_limits'])
    ? settings['matchup_rank_limits'].filter(
        (item): item is 100 | 200 | 500 | 1000 =>
          item === 100 || item === 200 || item === 500 || item === 1000,
      )
    : []
  const ranks = [...new Set(requestedRanks)].slice(0, 4)
  const opponentDisplaySeconds = integer(settings['opponent_display_seconds'], 30, 5, 120)
  const opponentSlideSeconds = Math.min(
    opponentDisplaySeconds - 1,
    integer(settings['opponent_slide_seconds'], 15, 3, 60),
  )
  const requestedAccountMode = choice(
    settings['streamer_account_mode'],
    ['stream_title', 'manual'],
    'stream_title',
  )
  const manualStreamerTag = text(settings['manual_streamer_tag'], '', 20)
  const streamerAccountMode =
    requestedAccountMode === 'manual' && !/^#?[0289PYLQGRJCUV]+$/i.test(manualStreamerTag)
      ? 'stream_title'
      : requestedAccountMode
  return {
    settings: {
      enabled: bool(settings['enabled']),
      opponentEnabled: bool(settings['opponent_enabled'], true),
      streamerStatsEnabled: bool(settings['streamer_stats_enabled'], true),
      previewMode: bool(settings['preview_mode']),
      previewTarget: choice(
        settings['preview_target'],
        ['stats', 'opponent', 'both'],
        'both',
      ),
      streamerAccountMode,
      manualStreamerTag,
      recentLimit: integer(settings['recent_limit'], 10, 1, 10),
      opponentDisplaySeconds,
      opponentSlideSeconds,
      opponentSecondSlideEnabled: bool(settings['opponent_second_slide_enabled'], true),
      opponentTransitionMs: integer(settings['opponent_transition_ms'], 550, 100, 3000),
      statsMainSeconds: integer(settings['stats_main_seconds'], 15, 5, 120),
      statsDeltaSeconds: integer(settings['stats_delta_seconds'], 5, 2, 30),
      statsBetweenSeconds: integer(settings['stats_between_seconds'], 4, 0, 30),
      statsPollMs: integer(settings['stats_poll_ms'], 1000, 500, 5000),
      statsTransitionMs: integer(settings['stats_transition_ms'], 500, 100, 3000),
      statsLayout: choice(
        settings['stats_layout'],
        ['compact', 'standard', 'detailed'],
        'detailed',
      ),
      opponentLayout: choice(
        settings['opponent_layout'],
        ['compact', 'standard', 'detailed'],
        'detailed',
      ),
      widgetFontStyle: choice(
        settings['widget_font_style'],
        ['gaming', 'clean', 'condensed'],
        'gaming',
      ),
      widgetCornerStyle: choice(
        settings['widget_corner_style'],
        ['rounded', 'square', 'pill'],
        'rounded',
      ),
      matchupEnabled: bool(settings['matchup_enabled'], true),
      matchupRankLimits:
        ranks.length > 0 ? ranks : DEFAULT_OVERLAY_SETTINGS.matchupRankLimits,
      matchupMinGames: integer(settings['matchup_min_games'], 5, 1, 100),
    },
    urls: {
      stats: obsPageUrl(
        input['streamer_stats_widget_page_url'],
        '/streamer-stats-widget',
      ),
      opponent: obsPageUrl(input['opponent_widget_page_url'], '/opponent-widget'),
    },
  }
}

export function titleToServer(settings: StreamTitleSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    paused: settings.paused,
    prefix_template: settings.prefixTemplate,
    wl_mode: settings.wlMode,
    account_display_mode: settings.accountDisplayMode,
    manual_account_tag: settings.manualAccountTag || null,
    include_rank: settings.includeRank,
    include_elo: settings.includeElo,
    include_wl: settings.includeWl,
    include_delta: settings.includeDelta,
    max_accounts: settings.maxAccounts,
    battle_mode: settings.battleMode,
    restore_title_on_offline: settings.restoreTitleOnOffline,
  }
}

export function overlayToServer(settings: OverlaySettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    opponent_enabled: settings.opponentEnabled,
    streamer_stats_enabled: settings.streamerStatsEnabled,
    preview_mode: settings.previewMode,
    preview_target: settings.previewTarget,
    streamer_account_mode: settings.streamerAccountMode,
    manual_streamer_tag: settings.manualStreamerTag,
    recent_limit: settings.recentLimit,
    opponent_display_seconds: settings.opponentDisplaySeconds,
    opponent_slide_seconds: settings.opponentSlideSeconds,
    opponent_second_slide_enabled: settings.opponentSecondSlideEnabled,
    opponent_transition_ms: settings.opponentTransitionMs,
    stats_main_seconds: settings.statsMainSeconds,
    stats_delta_seconds: settings.statsDeltaSeconds,
    stats_between_seconds: settings.statsBetweenSeconds,
    stats_poll_ms: settings.statsPollMs,
    stats_transition_ms: settings.statsTransitionMs,
    stats_layout: settings.statsLayout,
    opponent_layout: settings.opponentLayout,
    widget_font_style: settings.widgetFontStyle,
    widget_corner_style: settings.widgetCornerStyle,
    matchup_enabled: settings.matchupEnabled,
    matchup_source: 'top_200',
    matchup_rank_limits: settings.matchupRankLimits,
    matchup_min_games: settings.matchupMinGames,
  }
}

export function recommendedSizes(settings: OverlaySettings): {
  stats: string
  opponent: string
} {
  const stats = { compact: '360 x 48', standard: '480 x 64', detailed: '720 x 96' }
  const opponent = {
    compact: '420 x 300',
    standard: '560 x 380',
    detailed: '760 x 500',
  }
  return {
    stats: stats[settings.statsLayout],
    opponent: opponent[settings.opponentLayout],
  }
}
