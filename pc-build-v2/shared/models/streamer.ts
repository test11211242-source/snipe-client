import { z } from 'zod'

import { PublicErrorSchema } from '../errors/application-error'

const ShortTextSchema = z.string().max(300)
export const GAME_ACCOUNT_TAG_PATTERN = /^#?[0289PYLQGRJCUV]{3,15}$/i
export const GameAccountTagSchema = z
  .string()
  .trim()
  .regex(GAME_ACCOUNT_TAG_PATTERN)
  .transform((tag) => `#${tag.replace(/^#/, '').toUpperCase()}`)
const TagSchema = GameAccountTagSchema
const CountSchema = z.number().int().nonnegative().max(1_000_000)
export const MAX_STREAMER_ACCOUNTS = 20

const PredictionModeSchema = z.enum(['each_battle', 'streak'])
const predictionSettingsShape = {
  enabled: z.boolean(),
  mode: PredictionModeSchema,
  streakKind: z.enum(['fixed', 'random']),
  streakLength: z.number().int().min(2).max(10),
  streakFrom: z.number().int().min(1).max(10),
  streakTo: z.number().int().min(1).max(10),
  votingSeconds: z.union([
    z.literal(30),
    z.literal(45),
    z.literal(60),
    z.literal(90),
    z.literal(120),
    z.literal(180),
  ]),
  chatProgress: z.boolean(),
}
const validStreakRange = (settings: { streakFrom: number; streakTo: number }): boolean =>
  settings.streakFrom <= settings.streakTo
const STREAK_RANGE_ISSUE = { path: ['streakTo'], message: 'Invalid streak range' }

/** Outbound requests and the renderer view: unknown keys are rejected. */
export const PredictionSettingsSchema = z
  .object(predictionSettingsShape)
  .strict()
  .refine(validStreakRange, STREAK_RANGE_ISSUE)

/**
 * Server GET responses: additive fields from a newer server are stripped while
 * every known field keeps its type and bounds.
 */
export const PredictionSettingsResponseSchema = z
  .object(predictionSettingsShape)
  .refine(validStreakRange, STREAK_RANGE_ISSUE)

export const DEFAULT_PREDICTION_SETTINGS: PredictionSettings = {
  enabled: true,
  mode: 'each_battle',
  streakKind: 'fixed',
  streakLength: 3,
  streakFrom: 2,
  streakTo: 5,
  votingSeconds: 30,
  chatProgress: true,
}

const PredictionSourceSchema = z.enum(['snipe', 'twitch'])

const openPredictionShape = {
  id: z.number().int().positive(),
  title: z.string().max(200),
  mode: PredictionModeSchema,
  target: z.number().int().min(1).max(10),
  wins: z.number().int().nonnegative(),
  locksAt: z.string(),
  hasBets: z.boolean(),
  /** `twitch`: an adopted prediction that Snipe did not open. */
  source: PredictionSourceSchema,
  /** The server may resolve it from a reported battle outcome. */
  canSettle: z.boolean(),
}
const predictionStatsShape = {
  resolved: CountSchema,
  yes: CountSchema,
  no: CountSchema,
  canceled: CountSchema,
}
const predictionHistoryItemShape = {
  id: z.number().int().positive(),
  twitchPredictionId: z.string(),
  title: z.string().max(200),
  mode: PredictionModeSchema,
  target: z.number().int().min(1).max(10),
  wins: z.number().int().nonnegative(),
  phase: z.enum(['voting', 'locked', 'resolved_yes', 'resolved_no', 'canceled']),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  settledBy: z.enum(['screen', 'streamer', 'twitch', 'disable', 'stream_end']).nullable(),
  source: PredictionSourceSchema,
}

/** Main-projected renderer view items: unknown keys are rejected. */
const OpenPredictionSchema = z.object(openPredictionShape).strict()
const PredictionHistoryItemSchema = z.object(predictionHistoryItemShape).strict()

export type PredictionSource = z.infer<typeof PredictionSourceSchema>
export type OpenPrediction = z.infer<typeof OpenPredictionSchema>
export type PredictionHistoryItem = z.infer<typeof PredictionHistoryItemSchema>

/**
 * A server older than the source metadata only served predictions Snipe opened
 * and could settle; a `twitch` prediction without `canSettle` is never settled.
 */
const OpenPredictionResponseSchema = z
  .object({
    ...openPredictionShape,
    source: PredictionSourceSchema.default('snipe'),
    canSettle: z.boolean().optional(),
  })
  .transform(({ canSettle, ...prediction }): OpenPrediction => ({
    ...prediction,
    canSettle: canSettle ?? prediction.source === 'snipe',
  }))
const PredictionHistoryItemResponseSchema = z.object({
  ...predictionHistoryItemShape,
  source: PredictionSourceSchema.default('snipe'),
})

function predictionStatusShape<
  Prediction extends z.ZodType,
  Stats extends z.ZodType,
  HistoryItem extends z.ZodType,
>(prediction: Prediction, stats: Stats, historyItem: HistoryItem) {
  return {
    enabled: z.boolean(),
    live: z.boolean(),
    clientReady: z.boolean(),
    phase: z.enum([
      'voting',
      'locked',
      'disabled',
      'client_not_ready',
      'waiting_stream',
      'idle',
    ]),
    attention: z.string().max(64).nullable(),
    prediction: prediction.nullable(),
    stats,
    history: z.array(historyItem).max(10),
  }
}

/**
 * Server responses (status, heartbeat, settings save, manual commands):
 * unknown keys are stripped at every level so an additive server field never
 * breaks a released client, while known fields keep their types and bounds.
 * Missing prediction source metadata takes its pre-metadata meaning.
 */
export const PredictionStatusSchema = z.object(
  predictionStatusShape(
    OpenPredictionResponseSchema,
    z.object(predictionStatsShape),
    PredictionHistoryItemResponseSchema,
  ),
)

/** Main-projected renderer view: strict at every level. */
const predictionStatusViewShape = predictionStatusShape(
  OpenPredictionSchema,
  z.object(predictionStatsShape).strict(),
  PredictionHistoryItemSchema,
)

export type PredictionSettings = z.infer<typeof PredictionSettingsSchema>
export type PredictionStatus = z.infer<typeof PredictionStatusSchema>

export const OverlaySettingsSchema = z
  .object({
    enabled: z.boolean(),
    opponentEnabled: z.boolean(),
    streamerStatsEnabled: z.boolean(),
    previewMode: z.boolean(),
    previewTarget: z.enum(['stats', 'opponent', 'both']),
    streamerAccountMode: z.enum(['stream_title', 'manual']),
    manualStreamerTag: z.string().max(20),
    recentLimit: z.number().int().min(1).max(10),
    opponentDisplaySeconds: z.number().int().min(5).max(120),
    opponentSlideSeconds: z.number().int().min(3).max(60),
    opponentSecondSlideEnabled: z.boolean(),
    opponentTransitionMs: z.number().int().min(100).max(3000),
    statsMainSeconds: z.number().int().min(5).max(120),
    statsDeltaSeconds: z.number().int().min(2).max(30),
    statsBetweenSeconds: z.number().int().min(0).max(30),
    statsPollMs: z.number().int().min(500).max(5000),
    statsTransitionMs: z.number().int().min(100).max(3000),
    statsLayout: z.enum(['compact', 'standard', 'detailed']),
    opponentLayout: z.enum(['compact', 'standard', 'detailed']),
    widgetFontStyle: z.enum(['gaming', 'clean', 'condensed']),
    widgetCornerStyle: z.enum(['rounded', 'square', 'pill']),
    matchupEnabled: z.boolean(),
    matchupRankLimits: z
      .array(z.union([z.literal(100), z.literal(200), z.literal(500), z.literal(1000)]))
      .min(1)
      .max(4),
    matchupMinGames: z.number().int().min(1).max(100),
  })
  .strict()
  .superRefine((settings, context) => {
    if (
      settings.opponentSecondSlideEnabled &&
      settings.opponentSlideSeconds >= settings.opponentDisplaySeconds
    ) {
      context.addIssue({
        code: 'custom',
        path: ['opponentSlideSeconds'],
        message: 'Slide duration must be shorter than display duration',
      })
    }
    if (
      settings.streamerAccountMode === 'manual' &&
      !TagSchema.safeParse(settings.manualStreamerTag).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['manualStreamerTag'],
        message: 'A valid manual account tag is required',
      })
    }
  })

export const StreamTitleSettingsSchema = z
  .object({
    enabled: z.boolean(),
    paused: z.boolean(),
    prefixTemplate: z.string().max(200),
    wlMode: z.enum(['active', 'total']),
    accountDisplayMode: z.enum(['last_active', 'manual', 'best_elo', 'multiple']),
    manualAccountTag: z.string().max(20),
    includeRank: z.boolean(),
    includeElo: z.boolean(),
    includeWl: z.boolean(),
    includeDelta: z.boolean(),
    maxAccounts: z.number().int().min(1).max(MAX_STREAMER_ACCOUNTS),
    pollIntervalSeconds: z.number().int().min(2).max(30),
    twitchCheckIntervalSeconds: z.number().int().min(10).max(120),
    offlineGraceMinutes: z.number().int().min(1).max(120),
    battleMode: z.enum(['pathOfLegend', 'all']),
    restoreTitleOnOffline: z.boolean(),
  })
  .strict()

export const StreamTitlePreviewSchema = z
  .object({
    previewTitle: z.string().max(300),
    characterCount: z.number().int().nonnegative().max(300),
    warnings: z.array(z.string().min(1).max(300)).max(8),
  })
  .strict()

const SectionErrorSchema = z
  .object({
    section: z.enum(['twitch', 'predictions', 'title', 'deckSharing', 'overlay']),
    error: PublicErrorSchema,
  })
  .strict()

export const StreamerViewSchema = z
  .object({
    access: z
      .object({ allowed: z.boolean(), reason: ShortTextSchema.nullable() })
      .strict(),
    twitch: z
      .object({
        connected: z.boolean(),
        username: z.string().max(100).nullable(),
        polling: z.boolean(),
      })
      .strict(),
    predictions: z
      .object({ ...predictionStatusViewShape, settings: PredictionSettingsSchema })
      .strict(),
    title: z
      .object({
        settings: StreamTitleSettingsSchema,
        accounts: z
          .array(
            z
              .object({
                tag: z.string().max(20),
                name: z.string().max(100),
                alias: z.string().max(100),
                enabled: z.boolean(),
                currentRank: z.number().int().positive().max(1_000_000).nullable(),
                currentElo: z.number().int().nonnegative().max(100_000).nullable(),
              })
              .strict(),
          )
          .max(MAX_STREAMER_ACCOUNTS),
        session: z
          .object({
            totalWins: CountSchema,
            totalLosses: CountSchema,
            activeAccountTag: z.string().max(20).nullable(),
          })
          .strict()
          .nullable(),
        recentResults: z
          .array(
            z
              .object({
                result: z.enum(['win', 'loss', 'unknown']),
                accountTag: z.string().max(20).nullable(),
                at: z.string().max(40).nullable(),
              })
              .strict(),
          )
          .max(20),
        previewTitle: z.string().max(300),
        twitchOnline: z.boolean(),
      })
      .strict(),
    deckSharing: z.object({ enabled: z.boolean() }).strict(),
    overlay: z
      .object({
        settings: OverlaySettingsSchema,
        urlsAvailable: z.object({ stats: z.boolean(), opponent: z.boolean() }).strict(),
        maskedUrls: z
          .object({
            stats: z.string().max(80).nullable(),
            opponent: z.string().max(80).nullable(),
          })
          .strict(),
        recommendedSizes: z
          .object({ stats: z.string().max(32), opponent: z.string().max(32) })
          .strict(),
      })
      .strict(),
    refresh: z
      .object({
        state: z.enum(['idle', 'refreshing', 'ready', 'partial', 'failed']),
        errors: z.array(SectionErrorSchema).max(5),
        refreshedAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict()

export const OverlayUrlKindSchema = z.enum(['stats', 'opponent'])
export const StreamerConfirmationSchema = z
  .object({ confirmed: z.literal(true) })
  .strict()

export type OverlaySettings = z.infer<typeof OverlaySettingsSchema>
export type StreamTitleSettings = z.infer<typeof StreamTitleSettingsSchema>
export type StreamTitlePreview = z.infer<typeof StreamTitlePreviewSchema>
export type StreamerView = z.infer<typeof StreamerViewSchema>
export type OverlayUrlKind = z.infer<typeof OverlayUrlKindSchema>
