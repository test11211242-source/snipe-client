import { z } from 'zod'

export const ApplicationLifecycleStateSchema = z.enum([
  'BOOTING',
  'AUTHENTICATING',
  'READY',
  'RECOVERING',
  'SHUTTING_DOWN',
  'STOPPED',
])

export type ApplicationLifecycleState = z.infer<typeof ApplicationLifecycleStateSchema>

export const AppSnapshotSchema = z
  .object({
    lifecycle: ApplicationLifecycleStateSchema,
    version: z.string().min(1),
    settingsVersion: z.literal(1),
  })
  .strict()

export type AppSnapshot = z.infer<typeof AppSnapshotSchema>
