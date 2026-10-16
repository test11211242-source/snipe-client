import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PREDICTION_SETTINGS,
  PredictionSettingsResponseSchema,
  PredictionSettingsSchema,
  PredictionStatusSchema,
  StreamerViewSchema,
  type OpenPrediction,
  type PredictionSource,
} from '../../../shared/models/streamer'
import { createProductionServerConfig } from '../infrastructure/server-config'
import { ApiClient } from './api-client'
import { parsePredictions } from './streamer-adapters'

type PredictionMetadata = Pick<OpenPrediction, 'source' | 'canSettle'>

const logger = {
  debug: vi.fn<(message: string, context?: unknown) => void>(),
  warn: vi.fn<(message: string, context?: unknown) => void>(),
}

// The open prediction and history item a server sent before source metadata.
const legacyPrediction = {
  id: 41,
  title: 'Win the next battle?',
  mode: 'each_battle',
  target: 1,
  wins: 0,
  locksAt: '2026-10-15T12:00:30Z',
  hasBets: false,
} as const
const prediction = { ...legacyPrediction, source: 'snipe', canSettle: true } as const
const stats = { resolved: 3, yes: 2, no: 1, canceled: 0 }
const legacyHistoryItem = {
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
const historyItem = { ...legacyHistoryItem, source: 'snipe' } as const
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
  serverRevision: 7,
  prediction: { ...prediction, outcomes: [{ id: 'yes' }] },
  stats: { ...stats, refunded: 4 },
  history: [{ ...historyItem, battleId: 'battle-40' }],
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

/** HTTP 200 → response schema → adapter → strict main-renderer view. */
async function projectStatus(body: unknown) {
  const status = await getStatus(body)
  const settings = await getSettings(remoteSettings)
  if (!status.ok || !settings.ok) throw new Error('Server snapshot was rejected')
  return StreamerViewSchema.shape.predictions.parse(
    parsePredictions(status.data, settings.data),
  )
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
    const projected = await projectStatus(remoteStatus)
    expect(projected).toEqual({ ...knownStatus, settings: DEFAULT_PREDICTION_SETTINGS })
    expect(projected).not.toHaveProperty('serverRevision')
    expect(projected.prediction).not.toHaveProperty('outcomes')
    expect(projected.stats).not.toHaveProperty('refunded')
    expect(projected.history[0]).not.toHaveProperty('battleId')
    expect(projected.settings).not.toHaveProperty('autoCancelMinutes')
  })

  it.each<[PredictionSource, boolean]>([
    ['snipe', true],
    ['snipe', false],
    ['twitch', true],
    ['twitch', false],
  ])(
    'preserves an open %s prediction with canSettle=%s into the strict view',
    async (source, canSettle) => {
      const projected = await projectStatus({
        ...remoteStatus,
        attention: source === 'twitch' ? 'twitch_prediction_exists' : null,
        prediction: { ...remoteStatus.prediction, source, canSettle },
      })
      expect(projected.prediction).toEqual({ ...prediction, source, canSettle })
    },
  )

  it('preserves every history item source into the strict view', async () => {
    const projected = await projectStatus({
      ...remoteStatus,
      history: [
        { ...historyItem, id: 40, source: 'snipe', battleId: 'battle-40' },
        { ...historyItem, id: 39, source: 'twitch', battleId: 'battle-39' },
      ],
    })
    expect(projected.history).toEqual([
      { ...historyItem, id: 40, source: 'snipe' },
      { ...historyItem, id: 39, source: 'twitch' },
    ])
  })

  it('projects a history item Twitch closed without counting it in the stats', async () => {
    const external = {
      ...historyItem,
      id: 39,
      twitchPredictionId: 'tw-39',
      title: 'Who wins the tournament?',
      phase: 'resolved_external',
      settledBy: 'twitch',
      source: 'twitch',
    } as const
    const projected = await projectStatus({
      ...remoteStatus,
      phase: 'idle',
      prediction: null,
      history: [{ ...external, battleId: null }, remoteStatus.history[0]],
    })
    expect(projected.phase).toBe('idle')
    expect(projected.prediction).toBeNull()
    expect(projected.history).toEqual([external, historyItem])
    // Stats are the server's counts as sent; the client derives none from history.
    expect(projected.stats).toEqual(stats)
  })

  it.each<[string, Record<string, unknown>, PredictionMetadata]>([
    ['no metadata', legacyPrediction, { source: 'snipe', canSettle: true }],
    [
      'only a snipe source',
      { ...legacyPrediction, source: 'snipe' },
      { source: 'snipe', canSettle: true },
    ],
    [
      'only a twitch source',
      { ...legacyPrediction, source: 'twitch' },
      { source: 'twitch', canSettle: false },
    ],
    [
      'only canSettle=false',
      { ...legacyPrediction, canSettle: false },
      { source: 'snipe', canSettle: false },
    ],
  ])(
    'applies compatible defaults to an older server payload with %s',
    async (_case, open, metadata) => {
      const projected = await projectStatus({
        ...knownStatus,
        prediction: open,
        history: [legacyHistoryItem],
      })
      expect(projected.prediction).toEqual({ ...legacyPrediction, ...metadata })
      expect(projected.history).toEqual([{ ...legacyHistoryItem, source: 'snipe' }])
    },
  )

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
      'a history phase outside the enum',
      { ...remoteStatus, history: [{ ...historyItem, phase: 'resolved_draw' }] },
    ],
    [
      'a non-positive prediction id',
      { ...remoteStatus, prediction: { ...prediction, id: 0 } },
    ],
    [
      'an open prediction source outside the enum',
      { ...remoteStatus, prediction: { ...prediction, source: 'youtube' } },
    ],
    [
      'a null open prediction source',
      { ...remoteStatus, prediction: { ...prediction, source: null } },
    ],
    [
      'a non-boolean canSettle',
      { ...remoteStatus, prediction: { ...prediction, canSettle: 'yes' } },
    ],
    [
      'a null canSettle',
      { ...remoteStatus, prediction: { ...prediction, canSettle: null } },
    ],
    [
      'a history source outside the enum',
      { ...remoteStatus, history: [{ ...historyItem, source: 'youtube' }] },
    ],
    [
      'a null history source',
      { ...remoteStatus, history: [{ ...historyItem, source: null }] },
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
    ['the predictions section', { serverRevision: 7 }],
    ['the open prediction', { prediction: { ...prediction, outcomes: [{ id: 'yes' }] } }],
    ['the stats', { stats: { ...stats, refunded: 4 } }],
    ['a history item', { history: [{ ...historyItem, battleId: 'battle-40' }] }],
    ['the settings', { settings: remoteSettings }],
  ])('keeps the renderer view strict for unknown keys in %s', (_case, extra) => {
    const view = { ...knownStatus, settings: DEFAULT_PREDICTION_SETTINGS }
    expect(StreamerViewSchema.shape.predictions.safeParse(view).success).toBe(true)
    expect(
      StreamerViewSchema.shape.predictions.safeParse({ ...view, ...extra }).success,
    ).toBe(false)
  })

  it.each([
    [
      'an open prediction without source',
      { prediction: { ...legacyPrediction, canSettle: true } },
    ],
    [
      'an open prediction without canSettle',
      { prediction: { ...legacyPrediction, source: 'twitch' } },
    ],
    [
      'an open prediction source outside the enum',
      { prediction: { ...prediction, source: 'youtube' } },
    ],
    ['a history item without source', { history: [legacyHistoryItem] }],
  ])('requires known prediction metadata in the renderer view: %s', (_case, extra) => {
    const view = { ...knownStatus, settings: DEFAULT_PREDICTION_SETTINGS }
    expect(
      StreamerViewSchema.shape.predictions.safeParse({ ...view, ...extra }).success,
    ).toBe(false)
  })
})
