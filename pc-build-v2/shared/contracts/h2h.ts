import { z } from 'zod'
import { GameAccountTagSchema } from '../models/streamer'

export const H2H_CHANNELS = Object.freeze({ lookup: 'h2h:lookup', cancel: 'h2h:cancel' })
export const H2HRequestSchema = z
  .object({
    requestId: z.uuid(),
    opponentTag: GameAccountTagSchema,
    recentLimit: z.number().int().min(1).max(10).default(10),
  })
  .strict()
export const H2HCancelSchema = z.object({ requestId: z.uuid() }).strict()
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
const Result = z.enum(['win', 'loss', 'draw'])
const Rate = z.number().min(0).max(100).nullable()
const Time = z.iso.datetime({ offset: true })
const Meeting = z
  .object({ at: Time, result: Result, accountTag: GameAccountTagSchema })
  .strict()
export const H2HResponseSchema = z
  .object({
    status: z.enum(['ok', 'none', 'unavailable', 'no_accounts']),
    opponent: z
      .object({
        tag: GameAccountTagSchema,
        name: z.string().max(128).optional().nullable(),
      })
      .strict(),
    scope: z.literal('recorded_path_of_legends'),
    coverage: z
      .object({
        source: z.literal('cr_stats_current_and_archives'),
        complete: z.boolean(),
      })
      .strict(),
    updatedAt: Time,
    stale: z.boolean(),
    totals: z
      .object({
        meetings: Count,
        wins: Count,
        losses: Count,
        draws: Count,
        decisiveMeetings: Count,
        winRate: Rate,
      })
      .strict(),
    last: Meeting.nullable(),
    recent: z.array(Meeting).max(10),
    perAccount: z
      .array(
        z
          .object({
            accountTag: GameAccountTagSchema,
            alias: z.string().max(128),
            meetings: Count,
            wins: Count,
            losses: Count,
            draws: Count,
            decisiveMeetings: Count,
            winRate: Rate,
            lastAt: Time.nullable(),
            lastResult: Result.nullable(),
          })
          .strict(),
      )
      .max(20),
    reasonCode: z
      .enum([
        'H2H_SERVICE_UNAVAILABLE',
        'H2H_STATS_UNAVAILABLE',
        'H2H_HISTORY_TOO_LARGE',
        'ACCOUNT_SCOPE_UNAVAILABLE',
      ])
      .optional(),
  })
  .strict()

const HttpMeeting = Meeting.strip()
export const H2HHttpResponseSchema = H2HResponseSchema.extend({
  opponent: H2HResponseSchema.shape.opponent.strip(),
  coverage: H2HResponseSchema.shape.coverage.strip(),
  totals: H2HResponseSchema.shape.totals.strip(),
  last: HttpMeeting.nullable(),
  recent: z.array(HttpMeeting).max(10),
  perAccount: z.array(H2HResponseSchema.shape.perAccount.element.strip()).max(20),
}).strip()

export const H2HLookupResultSchema = z.discriminatedUnion('capability', [
  z
    .object({
      capability: z.literal('supported'),
      requestId: z.uuid(),
      data: H2HResponseSchema,
    })
    .strict(),
  z
    .object({
      capability: z.enum(['unsupported', 'unavailable', 'cancelled', 'rate_limited']),
      requestId: z.uuid(),
      retryAt: Time.nullable(),
      code: z.enum([
        'H2H_UNSUPPORTED',
        'H2H_REQUEST_FAILED',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'H2H_CANCELLED',
        'H2H_RATE_LIMITED',
      ]),
    })
    .strict(),
])
export type H2HRequest = z.input<typeof H2HRequestSchema>
export type H2HLookupResult = z.infer<typeof H2HLookupResultSchema>
export type ParsedH2HRequest = z.infer<typeof H2HRequestSchema>
