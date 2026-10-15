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

export const PredictionSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['each_battle', 'streak']),
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
  })
  .strict()
  .refine((settings) => settings.streakFrom <= settings.streakTo, {
    path: ['streakTo'],
    message: 'Invalid streak range',
  })

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

export const PredictionStatusSchema = z
  .object({
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
    prediction: z
      .object({
        id: z.number().int().positive(),
        title: z.string().max(200),
        mode: z.enum(['each_battle', 'streak']),
        target: z.number().int().min(1).max(10),
        wins: z.number().int().nonnegative(),
        locksAt: z.string(),
        hasBets: z.boolean(),
      })
      .strict()
      .nullable(),
    stats: z
      .object({
        resolved: CountSchema,
        yes: CountSchema,
        no: CountSchema,
        canceled: CountSchema,
      })
      .strict(),
    history: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            twitchPredictionId: z.string(),
            title: z.string().max(200),
            mode: z.enum(['each_battle', 'streak']),
            target: z.number().int().min(1).max(10),
            wins: z.number().int().nonnegative(),
            phase: z.enum([
              'voting',
              'locked',
              'resolved_yes',
              'resolved_no',
              'canceled',
            ]),
            createdAt: z.string(),
            endedAt: z.string().nullable(),
            settledBy: z
              .enum(['screen', 'streamer', 'twitch', 'disable', 'stream_end'])
              .nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()

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
    predictions: PredictionStatusSchema.extend({
      settings: PredictionSettingsSchema,
    }).strict(),
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
