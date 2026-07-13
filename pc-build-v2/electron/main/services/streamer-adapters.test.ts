import { describe, expect, it } from 'vitest'

import {
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

  it('normalizes inconsistent prediction and title payloads to strict bounded values', () => {
    const predictions = parsePredictions(
      {
        status: {
          is_active: true,
          state: 'x'.repeat(100),
          statistics: { total_predictions: 9_999_999, success_rate: 500 },
        },
      },
      {
        predictionType: 'win_lose',
        predictionWindow: 60,
        winStreakCount: 2,
        delayBetweenPredictions: 5,
        autoCreateNext: true,
      },
    )
    expect(predictions.state).toHaveLength(64)
    expect(predictions.statistics.total).toBe(1_000_000)
    expect(predictions.statistics.successRate).toBe(100)
    expect(
      parseTitle({
        settings: { account_display_mode: 'invalid' },
        accounts: new Array(10).fill({ tag: '#P0' }),
      }).accounts,
    ).toHaveLength(4)
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
