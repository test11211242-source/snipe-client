import { z } from 'zod'

export const RealtimeStateSchema = z.enum([
  'DISCONNECTED',
  'CONNECTING',
  'AUTHENTICATING',
  'READY',
  'BACKOFF',
])

export const RealtimeStatusSchema = z
  .object({
    state: RealtimeStateSchema,
    desiredConnected: z.boolean(),
    reconnectAttempt: z.number().int().nonnegative(),
    unknownEventCount: z.number().int().min(0).max(100),
  })
  .strict()

export type RealtimeState = z.infer<typeof RealtimeStateSchema>
export type RealtimeStatus = z.infer<typeof RealtimeStatusSchema>
