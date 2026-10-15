import { render } from '@testing-library/react'
import { vi, type Mock } from 'vitest'

import type {
  StreamerCommand,
  StreamerCommandResult,
  StreamerReadiness,
} from '../../../shared/contracts/streamer-ipc'
import {
  compileTitle,
  decompileTitle,
  type TitleBuilder,
} from '../../../shared/contracts/title-builder'
import {
  DEFAULT_PREDICTION_SETTINGS,
  StreamerViewSchema,
  type PredictionStatus,
  type StreamerView,
  type StreamTitleSettings,
} from '../../../shared/models/streamer'
import type { WidgetStatus } from '../../../shared/models/widget'
import { AppRoot } from '../app/AppRoot'
import type { AppRoute } from '../app/router'
import { authFixture, installBridge, type Bridge, type BridgeOptions } from './bridge'

const PROFILE_ID = '00000000-0000-4000-8000-000000000001'

type CurrentPrediction = NonNullable<PredictionStatus['prediction']>

/** An unsettled «Каждый бой» prediction with bets; tests patch what they need. */
export function predictionFixture(
  patch: Partial<CurrentPrediction> = {},
): CurrentPrediction {
  return {
    id: 41,
    title: 'Выиграю следующий бой?',
    mode: 'each_battle',
    target: 1,
    wins: 0,
    locksAt: '2026-10-10T12:00:30.000Z',
    hasBets: true,
    ...patch,
  }
}

/** A complete, valid StreamerView; tests mutate the returned copy. */
export function streamerViewFixture(): StreamerView {
  return StreamerViewSchema.parse({
    access: { allowed: true, reason: null },
    twitch: { connected: true, username: 'artcs_cr', polling: false },
    predictions: {
      enabled: true,
      live: false,
      clientReady: true,
      phase: 'waiting_stream',
      attention: null,
      prediction: null,
      stats: { resolved: 12, yes: 7, no: 5, canceled: 2 },
      history: [],
      settings: DEFAULT_PREDICTION_SETTINGS,
    },
    title: {
      settings: {
        enabled: false,
        paused: false,
        prefixTemplate: '{rank} · {elo} · {wins}W-{losses}L · {delta}',
        wlMode: 'active',
        accountDisplayMode: 'last_active',
        manualAccountTag: '',
        includeRank: true,
        includeElo: true,
        includeWl: true,
        includeDelta: true,
        maxAccounts: 3,
        pollIntervalSeconds: 5,
        twitchCheckIntervalSeconds: 30,
        offlineGraceMinutes: 5,
        battleMode: 'pathOfLegend',
        restoreTitleOnOffline: true,
      },
      accounts: [
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
      ],
      session: { totalWins: 5, totalLosses: 2, activeAccountTag: '#88299RC9Y' },
      recentResults: [
        { result: 'win', accountTag: '#88299RC9Y', at: null },
        { result: 'loss', accountTag: '#88299RC9Y', at: null },
      ],
      previewTitle: '★ 297 · 2 675 ELO · 5W-2L · +12',
      twitchOnline: true,
    },
    deckSharing: { enabled: false },
    overlay: {
      settings: {
        enabled: true,
        opponentEnabled: true,
        streamerStatsEnabled: true,
        previewMode: false,
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
      urlsAvailable: { stats: true, opponent: true },
      maskedUrls: {
        stats: 'api.artcsworld.xyz/streamer-stats-widget?key=••••',
        opponent: 'api.artcsworld.xyz/opponent-widget?key=••••',
      },
      recommendedSizes: { stats: '480x64', opponent: '560x380' },
    },
    refresh: { state: 'ready', errors: [], refreshedAt: '2026-10-10T12:00:00.000Z' },
  })
}

export function readinessFixture(
  patch: Partial<StreamerReadiness> = {},
): StreamerReadiness {
  return {
    twitchConnected: true,
    accountsCount: 2,
    monitoring: true,
    captureConfigured: true,
    predictionProfileReady: true,
    activeProfileId: PROFILE_ID,
    ...patch,
  }
}

type Success = Extract<StreamerCommandResult, { ok: true }>
export type CommandHandler = (
  command: StreamerCommand,
  fake: StreamerFake,
) => StreamerCommandResult | Promise<StreamerCommandResult> | undefined

export function ok(view: StreamerView, patch: Partial<Success> = {}): Success {
  return {
    ok: true,
    view,
    preview: null,
    warnings: [],
    titleApplication: 'not_requested',
    ...patch,
  }
}

export function failure(
  code: Extract<StreamerCommandResult, { ok: false }>['error']['code'],
  detail: string | null = null,
): StreamerCommandResult {
  return { ok: false, error: { code, detail } }
}

export interface StreamerFake {
  view: StreamerView
  readiness: StreamerReadiness
  widget: WidgetStatus
  /** First handler returning a result wins; otherwise the built-in state machine runs. */
  handlers: CommandHandler[]
  command: Mock<(command: StreamerCommand) => Promise<StreamerCommandResult>>
}

function applyDefault(
  fake: StreamerFake,
  command: StreamerCommand,
): StreamerCommandResult {
  const view = fake.view
  switch (command.action) {
    case 'chat.toggle':
      view.deckSharing.enabled = command.enabled
      break
    case 'title.enabled':
      view.title.settings.enabled = command.enabled
      break
    case 'title.paused':
      view.title.settings.paused = command.paused
      break
    case 'title.save':
    case 'title.apply':
      view.title.settings = command.settings
      if (command.action === 'title.apply')
        return ok(view, {
          titleApplication: 'unconfirmed',
          warnings: ['TITLE_APPLICATION_UNCONFIRMED'],
        })
      break
    case 'title.preview':
      return ok(view, {
        preview: {
          previewTitle: `PREVIEW ${command.settings.prefixTemplate}`,
          characterCount: command.settings.prefixTemplate.length,
          warnings: [],
        },
      })
    case 'widget.settings':
      view.overlay.settings = command.settings
      break
    case 'widget.enabled':
      view.overlay.settings.enabled = command.enabled
      break
    case 'predictions.settings.save':
      view.predictions.settings = command.settings
      view.predictions.enabled = command.settings.enabled
      if (view.predictions.prediction === null)
        view.predictions.phase = command.settings.enabled ? 'waiting_stream' : 'disabled'
      break
    case 'predictions.battle':
    case 'predictions.cancel': {
      const current = view.predictions.prediction
      // The server answers 409 for a prediction that is no longer the current one.
      if (current?.id !== command.predictionId) return failure('VALIDATION_FAILED')
      const stats = view.predictions.stats
      const won = command.action === 'predictions.battle' && command.outcome === 'win'
      // A streak win short of the target only counts one battle.
      if (won && current.wins + 1 < current.target) {
        current.wins += 1
        break
      }
      if (command.action === 'predictions.cancel') stats.canceled += 1
      else {
        stats.resolved += 1
        if (won) stats.yes += 1
        else stats.no += 1
      }
      view.predictions.prediction = null
      view.predictions.attention = null
      view.predictions.phase = 'idle'
      break
    }
    case 'twitch.disconnect':
      view.twitch.connected = false
      view.twitch.username = null
      fake.readiness.twitchConnected = false
      break
    case 'twitch.connect':
      view.twitch.polling = true
      break
    case 'accounts.add':
      view.title.accounts.push({
        tag: command.tag,
        name: command.alias || command.tag,
        alias: command.alias,
        enabled: true,
        currentRank: null,
        currentElo: null,
      })
      break
    case 'accounts.remove':
      view.title.accounts = view.title.accounts.filter((a) => a.tag !== command.tag)
      break
    case 'accounts.reenable':
      for (const account of view.title.accounts)
        if (account.tag === command.tag) account.enabled = true
      break
    default:
      break
  }
  return ok(structuredClone(view))
}

/** The `crTools.streamer` fakes, for assertions. */
export interface StreamerApiFake {
  compileTitle: Mock<
    (payload: {
      settings: StreamTitleSettings
      builder: TitleBuilder
    }) => Promise<unknown>
  >
  decompileTitle: Mock<(settings: StreamTitleSettings) => Promise<unknown>>
  getReadiness: Mock<() => Promise<StreamerReadiness>>
}

export interface StreamWorld {
  bridge: Bridge
  fake: StreamerFake
  api: StreamerApiFake
}

export interface StreamOptions extends BridgeOptions {
  view?: (view: StreamerView) => void
  readiness?: Partial<StreamerReadiness>
  roles?: readonly ('user' | 'streamer')[]
}

/** Installs the bridge with a stateful fake of the streamer capabilities (no rendering). */
export function installStream(options: StreamOptions = {}): StreamWorld {
  const { view: patchView, readiness, roles, ...bridgeOptions } = options
  const bridge = installBridge({
    auth: authFixture(roles ?? ['user', 'streamer']),
    ...bridgeOptions,
  })
  const view = streamerViewFixture()
  patchView?.(view)
  const widget: WidgetStatus = {
    visible: false,
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
  const fake = {
    view,
    readiness: readinessFixture(readiness),
    widget,
    handlers: [],
  } as unknown as StreamerFake
  fake.command = vi.fn((command: StreamerCommand) => {
    for (const handler of fake.handlers) {
      const result = handler(command, fake)
      if (result !== undefined) return Promise.resolve(result)
    }
    return Promise.resolve(applyDefault(fake, command))
  })

  const crTools = bridge.crTools as Record<string, unknown>
  crTools['setStreamerSectionActive'] = vi.fn(() =>
    Promise.resolve(structuredClone(fake.view)),
  )
  crTools['getStreamerView'] = vi.fn(() => Promise.resolve(structuredClone(fake.view)))
  crTools['refreshStreamer'] = vi.fn(() => Promise.resolve(structuredClone(fake.view)))
  const api: StreamerApiFake = {
    getReadiness: vi.fn(() => Promise.resolve({ ...fake.readiness })),
    compileTitle: vi.fn(
      ({
        settings,
        builder,
      }: {
        settings: StreamTitleSettings
        builder: TitleBuilder
      }) => {
        try {
          return Promise.resolve({ ok: true, settings: compileTitle(settings, builder) })
        } catch (cause) {
          return Promise.resolve({
            ok: false,
            code:
              cause instanceof Error &&
              cause.message === 'TITLE_ACCOUNT_SELECTION_CONFLICT'
                ? cause.message
                : 'VALIDATION_FAILED',
          })
        }
      },
    ),
    decompileTitle: vi.fn((settings: StreamTitleSettings) =>
      Promise.resolve(decompileTitle(settings)),
    ),
  }
  crTools['streamer'] = { command: fake.command, ...api }
  crTools['getWidgetStatus'] = vi.fn(() => Promise.resolve(structuredClone(fake.widget)))
  crTools['updateWidgetSettings'] = vi.fn((patch: Partial<WidgetStatus['settings']>) => {
    fake.widget.settings = { ...fake.widget.settings, ...patch }
    return Promise.resolve(structuredClone(fake.widget.settings))
  })
  crTools['toggleWidget'] = vi.fn(() => {
    fake.widget.visible = !fake.widget.visible
    return Promise.resolve(structuredClone(fake.widget))
  })
  crTools['openLogFolder'] = vi.fn(() => Promise.resolve({ opened: true }))

  return { bridge, fake, api }
}

/** Mounts the app on `route` as a streamer. */
export function mountStream(route: AppRoute, options: StreamOptions = {}): StreamWorld {
  const world = installStream(options)
  render(<AppRoot initialRoute={route} />)
  return world
}
