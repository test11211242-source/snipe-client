import { z } from 'zod'

export const MonitorStateSchema = z.enum([
  'STOPPED',
  'PREFLIGHT',
  'STARTING',
  'READY',
  'STOPPING',
  'FAILED',
])
export const SearchModeSchema = z.enum(['fast', 'precise'])
export const DeckModeSchema = z.enum(['pol', 'gt'])

export const MonitorPreferencesSchema = z
  .object({
    searchMode: SearchModeSchema,
    deckMode: DeckModeSchema,
  })
  .strict()

const SafeTextSchema = z.string().trim().min(1).max(160)
const OptionalSafeTextSchema = SafeTextSchema.nullable()

export const MonitorDeckCardSchema = z
  .object({
    name: SafeTextSchema,
    level: z.number().int().min(0).max(100).nullable(),
    evolutionLevel: z.number().int().min(0).max(10).nullable(),
    iconUrl: z.url().max(500).nullable(),
  })
  .strict()

export const MonitorDeckSchema = z
  .object({
    label: OptionalSafeTextSchema,
    cards: z.array(MonitorDeckCardSchema).max(8),
  })
  .strict()

const ResultBaseSchema = z.object({
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  searchMode: SearchModeSchema,
  deckMode: DeckModeSchema,
  searchedNickname: OptionalSafeTextSchema,
})

export const MonitorResultSchema = z.discriminatedUnion('kind', [
  ResultBaseSchema.extend({
    kind: z.literal('player_found'),
    player: z
      .object({
        name: SafeTextSchema,
        tag: OptionalSafeTextSchema,
        rating: z.number().int().min(0).max(100_000).nullable(),
        clan: OptionalSafeTextSchema,
      })
      .strict(),
    decks: z.array(MonitorDeckSchema).max(5),
  }).strict(),
  ResultBaseSchema.extend({
    kind: z.literal('player_not_found'),
    message: SafeTextSchema,
  }).strict(),
  ResultBaseSchema.extend({
    kind: z.literal('recognition_failed'),
    message: SafeTextSchema,
  }).strict(),
  ResultBaseSchema.extend({
    kind: z.literal('service_error'),
    message: SafeTextSchema,
    retryable: z.boolean(),
    authBlocked: z.boolean(),
  }).strict(),
])

export const MonitorSessionStatsSchema = z
  .object({
    triggers: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requests: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    droppedActions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    playersFound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    playersNotFound: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    recognitionFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    serviceErrors: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

export const MonitorReadinessSchema = z
  .object({
    authenticated: z.boolean(),
    captureConfigured: z.boolean(),
    sourceAvailable: z.boolean().nullable(),
  })
  .strict()

export const MonitorPublicErrorSchema = z
  .object({
    code: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .max(64),
    message: z.string().min(1).max(300),
  })
  .strict()

export const MonitorViewSchema = z
  .object({
    state: MonitorStateSchema,
    preferences: MonitorPreferencesSchema,
    readiness: MonitorReadinessSchema,
    error: MonitorPublicErrorSchema.nullable(),
    startedAt: z.iso.datetime().nullable(),
    stats: MonitorSessionStatsSchema,
    results: z.array(MonitorResultSchema).max(20),
  })
  .strict()

export type MonitorState = z.infer<typeof MonitorStateSchema>
export type SearchMode = z.infer<typeof SearchModeSchema>
export type DeckMode = z.infer<typeof DeckModeSchema>
export type MonitorPreferences = z.infer<typeof MonitorPreferencesSchema>
export type MonitorResult = z.infer<typeof MonitorResultSchema>
export type MonitorSessionStats = z.infer<typeof MonitorSessionStatsSchema>
export type MonitorView = z.infer<typeof MonitorViewSchema>
