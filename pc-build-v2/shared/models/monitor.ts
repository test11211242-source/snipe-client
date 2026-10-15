import { z } from 'zod'

import { MonitorLearningCodeSchema } from '../contracts/monitor-protocol'

export const MonitorStateSchema = z.enum([
  'STOPPED',
  'PREFLIGHT',
  'STARTING',
  'READY',
  'WAITING_SOURCE',
  'STOPPING',
  'FAILED',
])
const LegacyResultSearchModeSchema = z.enum(['fast', 'precise'])
export const DeckModeSchema = z.enum(['pol', 'gt'])

export const MonitorPreferencesSchema = z
  .object({
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
  searchMode: LegacyResultSearchModeSchema,
  deckMode: DeckModeSchema,
  searchedNickname: OptionalSafeTextSchema,
  reprocessed: z.boolean().default(false),
  capturePolicy: z.literal('immediate_nickname').nullable().default(null),
  sessionId: z.uuid().nullable().default(null),
  triggerId: z.uuid().nullable().default(null),
  attemptId: z.uuid().nullable().default(null),
  profileId: z.uuid().nullable().default(null),
  calibrationRevision: z.number().int().positive().nullable().default(null),
  repeat: z
    .object({
      previousAt: z.iso.datetime(),
      previousResultId: z.uuid(),
      localDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict()
    .nullable()
    .default(null),
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

export const MonitorSearchSchema = z
  .object({
    triggerId: z.uuid(),
    attemptId: z.uuid(),
    profileId: z.uuid(),
    calibrationRevision: z.number().int().positive(),
    phase: z.enum(['capturing', 'requesting', 'completed', 'failed']),
    startedAt: z.iso.datetime(),
    searchedNickname: OptionalSafeTextSchema,
    retryExpiresAt: z.iso.datetime().nullable(),
  })
  .strict()

export const MonitorSessionSchema = z
  .object({
    sessionId: z.uuid(),
    userId: z.string().min(1).max(128),
    initialProfileId: z.uuid().nullable().default(null),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    stopReason: z
      .enum(['user', 'auth_change', 'profile_deleted', 'exit', 'failed'])
      .nullable(),
    durationMs: z.number().int().nonnegative(),
    stats: MonitorSessionStatsSchema,
    repeatEncounters: z.number().int().nonnegative(),
    distinctRepeatedOpponents: z.number().int().nonnegative(),
  })
  .strict()

export const MonitorGeometrySchema = z
  .object({
    state: z.enum([
      'locating',
      'armed',
      'no_game',
      'aspect_mismatch',
      'learning',
      'learning_failed',
    ]),
    aspectLabel: z.string().min(1).max(80).nullable(),
    learningFailure: MonitorLearningCodeSchema.nullable(),
  })
  .strict()

export const MonitorViewSchema = z
  .object({
    seq: z.number().int().nonnegative().default(0),
    state: MonitorStateSchema,
    preferences: MonitorPreferencesSchema,
    readiness: MonitorReadinessSchema,
    error: MonitorPublicErrorSchema.nullable(),
    startedAt: z.iso.datetime().nullable(),
    stats: MonitorSessionStatsSchema,
    results: z.array(MonitorResultSchema).max(20),
    runIntent: z.boolean().default(false),
    search: MonitorSearchSchema.nullable().default(null),
    session: MonitorSessionSchema.nullable().default(null),
    summary: MonitorSessionSchema.nullable().default(null),
    historyError: MonitorPublicErrorSchema.nullable().default(null),
    geometry: MonitorGeometrySchema.nullable().default(null),
    /** The running window source is minimised: analysis is paused until it is restored. */
    sourceMinimized: z.boolean().default(false),
    /**
     * Automatic recovery in flight: `source` waits for a lost game window, `worker`
     * restarts a failed worker. Set on WAITING_SOURCE and kept through the attempt's
     * PREFLIGHT/STARTING; any other state clears it.
     */
    recovery: z.enum(['source', 'worker']).nullable().default(null),
  })
  .strict()

export type MonitorState = z.infer<typeof MonitorStateSchema>
export type DeckMode = z.infer<typeof DeckModeSchema>
export type MonitorPreferences = z.infer<typeof MonitorPreferencesSchema>
export type MonitorResult = z.infer<typeof MonitorResultSchema>
export type MonitorSessionStats = z.infer<typeof MonitorSessionStatsSchema>
export type MonitorView = z.infer<typeof MonitorViewSchema>
export type MonitorSession = z.infer<typeof MonitorSessionSchema>
export type MonitorSearch = z.infer<typeof MonitorSearchSchema>

/**
 * The state every surface (main window, tray, overlay) presents. Recovery never flaps:
 * a source retry stays «waiting for the game window» through its PREFLIGHT/STARTING, and
 * a worker restart reads as a start, never as a lost window.
 */
export function presentedMonitorState(
  view: Pick<MonitorView, 'state' | 'recovery'>,
): MonitorState {
  if (
    view.recovery === 'source' &&
    (view.state === 'PREFLIGHT' || view.state === 'STARTING')
  )
    return 'WAITING_SOURCE'
  if (view.recovery === 'worker' && view.state === 'WAITING_SOURCE') return 'STARTING'
  return view.state
}
