import { describe, expect, it } from 'vitest'

import {
  MAX_STREAMER_ACCOUNTS,
  DEFAULT_PREDICTION_SETTINGS,
  OverlaySettingsSchema,
  StreamerViewSchema,
} from '../../../shared/models/streamer'
import {
  DEFAULT_OVERLAY_SETTINGS,
  parseOverlay,
  parsePredictions,
  parseTitle,
  recommendedSizes,
} from './streamer-adapters'
import { predictionStatusFixture } from '../../../tests/prediction-fixtures'

describe('streamer server adapters', () => {
  it('bounds loose status data and never projects overlay tokens or raw URLs into the view', () => {
    const overlay = parseOverlay({
      settings: { ...DEFAULT_OVERLAY_SETTINGS, widget_token: 'secret-token' },
      opponent_widget_page_url:
        'https://api.artcsworld.xyz/opponent-widget?token=secret-token',
      streamer_stats_widget_page_url:
        'https://api.artcsworld.xyz/stats?token=secret-token',
      raw_model_output: 'private',
    })
    expect(OverlaySettingsSchema.parse(overlay.settings)).toEqual(
      DEFAULT_OVERLAY_SETTINGS,
    )
    const serialized = JSON.stringify(overlay.settings)
    expect(serialized).not.toContain('secret-token')
    expect(overlay.urls.opponent).toContain('secret-token')
  })

  it('projects authoritative prediction counts and bounds loose title payloads', () => {
    const predictions = parsePredictions(
      { ...predictionStatusFixture, stats: { resolved: 8, yes: 3, no: 5, canceled: 2 } },
      DEFAULT_PREDICTION_SETTINGS,
    )
    expect(predictions.phase).toBe('waiting_stream')
    expect(predictions.stats).toEqual({ resolved: 8, yes: 3, no: 5, canceled: 2 })
    expect(predictions.settings.votingSeconds).toBe(30)
    expect(
      parseTitle({
        settings: { account_display_mode: 'invalid', max_accounts: 999 },
        accounts: new Array(25).fill({ tag: '#P0' }),
      }).accounts,
    ).toHaveLength(MAX_STREAMER_ACCOUNTS)
    expect(parseTitle({ settings: { max_accounts: 999 } }).settings.maxAccounts).toBe(
      MAX_STREAMER_ACCOUNTS,
    )
  })

  it('rejects secrets and unknown fields at the aggregate renderer boundary', () => {
    expect(() => StreamerViewSchema.parse({ widgetToken: 'secret' })).toThrow()
  })

  it('uses the active V1 OBS dimensions for every layout', () => {
    expect(
      ['compact', 'standard', 'detailed'].map((layout) =>
        recommendedSizes({
          ...DEFAULT_OVERLAY_SETTINGS,
          statsLayout: layout as 'compact' | 'standard' | 'detailed',
          opponentLayout: layout as 'compact' | 'standard' | 'detailed',
        }),
      ),
    ).toEqual([
      { stats: '360 x 48', opponent: '420 x 300' },
      { stats: '480 x 64', opponent: '560 x 380' },
      { stats: '720 x 96', opponent: '760 x 500' },
    ])
  })
})
