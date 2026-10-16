import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PREDICTION_SETTINGS,
  PredictionSettingsResponseSchema,
  PredictionSettingsSchema,
  PredictionStatusSchema,
  StreamerViewSchema,
} from '../../../shared/models/streamer'
import { createProductionServerConfig } from '../infrastructure/server-config'
import { ApiClient } from './api-client'
import { parsePredictions } from './streamer-adapters'

const logger = {
  debug: vi.fn<(message: string, context?: unknown) => void>(),
  warn: vi.fn<(message: string, context?: unknown) => void>(),
}

const prediction = {
  id: 41,
  title: 'Win the next battle?',
  mode: 'each_battle',
  target: 1,
  wins: 0,
  locksAt: '2026-10-15T12:00:30Z',
  hasBets: false,
} as const
const stats = { resolved: 3, yes: 2, no: 1, canceled: 0 }
const historyItem = {
  id: 40,
  twitchPredictionId: 'tw-40',
  title: 'Win the next battle?',
  mode: 'each_battle',
  target: 1,
  wins: 1,
  phase: 'resolved_yes',
  createdAt: '2026-10-15T11:50:00Z',
  endedAt: '2026-10-15T11:55:00Z',
  settledBy: 'screen',
} as const
const knownStatus = {
  enabled: true,
  live: true,
  clientReady: true,
  phase: 'voting',
  attention: null,
  prediction,
  stats,
  history: [historyItem],
} as const

// A newer server adds fields at every level of the payload.
const remoteStatus = {
  ...knownStatus,
  source: 'snipe',
  serverRevision: 7,
  prediction: { ...prediction, source: 'twitch', outcomes: [{ id: 'yes' }] },
  stats: { ...stats, refunded: 4 },
  history: [{ ...historyItem, source: 'snipe', battleId: 'battle-40' }],
}
const remoteSettings = { ...DEFAULT_PREDICTION_SETTINGS, autoCancelMinutes: 15 }

function serving(body: unknown): ApiClient {
  return new ApiClient(
    createProductionServerConfig(),
    vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    ),
    logger,
  )
}

function getStatus(body: unknown) {
  return serving(body).request({
    method: 'GET',
    path: '/api/streamer/predictions/status',
    schema: PredictionStatusSchema,
  })
}

function getSettings(body: unknown) {
  return serving(body).request({
    method: 'GET',
    path: '/api/streamer/predictions/settings',
    schema: PredictionSettingsResponseSchema,
  })
}

describe('prediction server response boundary', () => {
  it.each([false, true])(
    'projects current server enabled=%s through a fresh HTTP client, not local settings',
    async (enabled) => {
      const status = await getStatus({
        ...remoteStatus,
        enabled,
        phase: enabled ? 'voting' : 'idle',
        prediction: enabled ? remoteStatus.prediction : null,
      })
      const settings = await getSettings({ ...remoteSettings, enabled: !enabled })
      if (!status.ok || !settings.ok) throw new Error('Server snapshot was rejected')
      const view = parsePredictions(status.data, settings.data)
      expect(view.enabled).toBe(enabled)
      expect(view.phase).toBe(enabled ? 'voting' : 'idle')
      expect(view.prediction?.id ?? null).toBe(enabled ? prediction.id : null)
      expect(view.settings.enabled).toBe(!enabled)
    },
  )

  it('projects an HTTP 200 payload with nested additive fields into the strict view', async () => {
    const status = await getStatus(remoteStatus)
    const settings = await getSettings(remoteSettings)
    if (!status.ok || !settings.ok) throw new Error('Additive fields were rejected')

    const projected = parsePredictions(status.data, settings.data)
    const expected = { ...knownStatus, settings: DEFAULT_PREDICTION_SETTINGS }
    expect(projected).toEqual(expected)
    expect(projected).not.toHaveProperty('source')
    expect(projected).not.toHaveProperty('serverRevision')
    expect(projected.prediction).not.toHaveProperty('source')
    expect(projected.prediction).not.toHaveProperty('outcomes')
    expect(projected.stats).not.toHaveProperty('refunded')
    expect(projected.history[0]).not.toHaveProperty('source')
    expect(projected.history[0]).not.toHaveProperty('battleId')
    expect(projected.settings).not.toHaveProperty('autoCancelMinutes')
    expect(StreamerViewSchema.shape.predictions.parse(projected)).toEqual(expected)
  })

  it('strips additive fields when the adapter receives a raw server payload', () => {
    expect(parsePredictions(remoteStatus, remoteSettings)).toEqual({
      ...knownStatus,
      settings: DEFAULT_PREDICTION_SETTINGS,
    })
  })

  it.each([
    ['a phase outside the unchanged enum', { ...remoteStatus, phase: 'refunded' }],
    [
      'a settledBy outside the unchanged enum',
      { ...remoteStatus, history: [{ ...historyItem, settledBy: 'snipe' }] },
    ],
    [
      'a non-positive prediction id',
      { ...remoteStatus, prediction: { ...prediction, id: 0 } },
    ],
    ['a negative count', { ...remoteStatus, stats: { ...stats, yes: -1 } }],
    [
      'a missing required count',
      { ...remoteStatus, stats: { resolved: 3, yes: 2, no: 1 } },
    ],
    [
      'more than ten history items',
      { ...remoteStatus, history: Array.from({ length: 11 }, () => historyItem) },
    ],
    ['an oversized attention code', { ...remoteStatus, attention: 'x'.repeat(65) }],
    ['a mistyped known field', { ...remoteStatus, clientReady: 'yes' }],
  ])('rejects a status response with %s', async (_case, body) => {
    await expect(getStatus(body)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    })
  })

  it.each([
    ['an unsupported voting duration', { ...remoteSettings, votingSeconds: 15 }],
    ['an inverted streak range', { ...remoteSettings, streakFrom: 6, streakTo: 4 }],
    ['an unknown mode', { ...remoteSettings, mode: 'every_round' }],
  ])('rejects a settings response with %s', async (_case, body) => {
    await expect(getSettings(body)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    })
  })

  it('keeps outbound settings strict', () => {
    expect(PredictionSettingsSchema.safeParse(remoteSettings).success).toBe(false)
    expect(PredictionSettingsSchema.parse(DEFAULT_PREDICTION_SETTINGS)).toEqual(
      DEFAULT_PREDICTION_SETTINGS,
    )
  })

  it.each([
    ['the predictions section', { source: 'snipe' }],
    ['the open prediction', { prediction: { ...prediction, source: 'twitch' } }],
    ['the stats', { stats: { ...stats, refunded: 4 } }],
    ['a history item', { history: [{ ...historyItem, source: 'snipe' }] }],
    ['the settings', { settings: remoteSettings }],
  ])('keeps the renderer view strict for unknown keys in %s', (_case, extra) => {
    const view = { ...knownStatus, settings: DEFAULT_PREDICTION_SETTINGS }
    expect(StreamerViewSchema.shape.predictions.safeParse(view).success).toBe(true)
    expect(
      StreamerViewSchema.shape.predictions.safeParse({ ...view, ...extra }).success,
    ).toBe(false)
  })
})
