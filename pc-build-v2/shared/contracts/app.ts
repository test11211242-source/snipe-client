import { z } from 'zod'

import { AppSnapshotSchema } from '../models/application'

export const IPC_CHANNELS = Object.freeze({
  hello: 'app:hello',
  getSnapshot: 'app:get-snapshot',
  getSettings: 'app:get-settings',
  updateSettings: 'app:update-settings',
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
  })
  .strict()
export const AppSettingsPayloadSchema = z.object({}).strict()
export const AppSettingsUpdateSchema = AppSettingsViewSchema

export type HelloResult = z.infer<typeof HelloResultSchema>
export type AppSettingsView = z.infer<typeof AppSettingsViewSchema>
