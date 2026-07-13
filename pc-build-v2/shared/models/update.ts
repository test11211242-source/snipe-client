import { z } from 'zod'

export const UPDATE_STATES = [
  'IDLE',
  'CHECKING',
  'AVAILABLE',
  'DOWNLOADING',
  'READY',
  'UP_TO_DATE',
  'FAILED',
] as const

export const UpdateStateSchema = z.enum(UPDATE_STATES)
const UpdateVersionSchema = z
  .string()
  .max(32)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)

export const UpdatePublicErrorSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_]+$/),
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
  })
  .strict()

export const UpdateProgressSchema = z
  .object({
    downloadedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive(),
    percent: z.number().min(0).max(100),
  })
  .strict()

export const UpdateViewSchema = z
  .object({
    state: UpdateStateSchema,
    currentVersion: UpdateVersionSchema,
    availableVersion: UpdateVersionSchema.nullable(),
    critical: z.boolean(),
    releaseNotes: z.array(z.string().min(1).max(1_000)).max(20),
    progress: UpdateProgressSchema.nullable(),
    error: UpdatePublicErrorSchema.nullable(),
  })
  .strict()

export type UpdateState = z.infer<typeof UpdateStateSchema>
export type UpdatePublicError = z.infer<typeof UpdatePublicErrorSchema>
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>
export type UpdateView = z.infer<typeof UpdateViewSchema>
