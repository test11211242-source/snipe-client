import { z } from 'zod'

import { AppSnapshotSchema } from '../models/application'

export const IPC_CHANNELS = Object.freeze({
  hello: 'app:hello',
  getSnapshot: 'app:get-snapshot',
  getSettings: 'app:get-settings',
  updateSettings: 'app:update-settings',
  openLogFolder: 'app:open-log-folder',
  reportBootstrapFailure: 'app:report-bootstrap-failure',
})

export const HelloPayloadSchema = z
  .object({
    protocolVersion: z.literal(1),
    client: z.literal('main-renderer'),
  })
  .strict()

export const HelloResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    message: z.literal('hello from CR Tools V2'),
  })
  .strict()

export const AppSnapshotPayloadSchema = z.object({}).strict()
export const AppSnapshotResultSchema = AppSnapshotSchema

export const AppSettingsViewSchema = z
  .object({
    reducedMotion: z.boolean(),
    launchAtStartup: z.boolean(),
    diagnosticsEnabled: z.boolean(),
    autoStartMonitoring: z.boolean(),
    closeToTray: z.boolean(),
    notifyOpponentFound: z.boolean(),
  })
  .strict()
export const AppSettingsPayloadSchema = z.object({}).strict()
export const AppSettingsUpdateSchema = AppSettingsViewSchema.partial().refine(
  (value) => Object.values(value).every((item) => item !== undefined),
  'Settings patches cannot contain undefined values',
)
export type AppSettingsUpdate = z.infer<typeof AppSettingsUpdateSchema>
export const OpenLogFolderResultSchema = z.object({ opened: z.boolean() }).strict()
export const BootstrapFailurePayloadSchema = z
  .object({
    capability: z.enum([
      'protocol',
      'snapshot',
      'auth',
      'realtime',
      'capture',
      'profiles',
      'monitor',
      'widget',
      'settings',
      'update',
    ]),
    code: z.enum(['INVALID_RESPONSE', 'IPC_FAILED']),
  })
  .strict()
export type BootstrapFailure = z.infer<typeof BootstrapFailurePayloadSchema>

export type HelloResult = z.infer<typeof HelloResultSchema>
export type AppSettingsView = z.infer<typeof AppSettingsViewSchema>
