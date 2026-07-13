import { z } from 'zod'

import { PublicErrorSchema } from '../errors/application-error'

const ShortTextSchema = z.string().max(300)
const TagSchema = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^#?[0289PYLQGRJCUV]+$/i)
const CountSchema = z.number().int().nonnegative().max(1_000_000)

export const PredictionPreferencesSchema = z
  .object({
    predictionType: z.enum(['win_lose', 'win_streak', 'mix']),
    predictionWindow: z.number().int().min(30).max(1800),
    winStreakCount: z.number().int().min(2).max(10),
    delayBetweenPredictions: z.number().int().min(1).max(60),
    autoCreateNext: z.boolean(),
  })
  .strict()

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
    maxAccounts: z.number().int().min(1).max(4),
    pollIntervalSeconds: z.number().int().min(2).max(30),
    twitchCheckIntervalSeconds: z.number().int().min(10).max(120),
    offlineGraceMinutes: z.number().int().min(1).max(120),
    battleMode: z.enum(['pathOfLegend', 'all']),
    restoreTitleOnOffline: z.boolean(),
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
      .object({
        active: z.boolean(),
        state: z.string().max(64),
        runtimeState: z.enum(['stopped', 'active', 'failed', 'unknown']),
        settings: PredictionPreferencesSchema,
        statistics: z
          .object({
            total: CountSchema,
            successful: CountSchema,
            successRate: z.number().min(0).max(100),
            currentWinStreak: CountSchema,
            activeTitle: z.string().max(200).nullable(),
          })
          .strict(),
        requirements: z
          .object({
            twitchConnected: z.boolean(),
            mainMonitorConfigured: z.boolean(),
            mainMonitorRunning: z.boolean(),
            resultConfigured: z.boolean(),
          })
          .strict(),
      })
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
          .max(4),
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

export type PredictionPreferences = z.infer<typeof PredictionPreferencesSchema>
export type OverlaySettings = z.infer<typeof OverlaySettingsSchema>
export type StreamTitleSettings = z.infer<typeof StreamTitleSettingsSchema>
export type StreamerView = z.infer<typeof StreamerViewSchema>
export type OverlayUrlKind = z.infer<typeof OverlayUrlKindSchema>
