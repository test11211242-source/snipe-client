import { z } from 'zod'

import {
  CaptureProfileIdSchema,
  CaptureProfileNameSchema,
  CaptureProfilesViewSchema,
  CaptureSourceSnapshotSchema,
  CaptureStatusSchema,
  NormalizedRectSchema,
  RegionKindSchema,
} from '../models/capture'
import { MonitorViewSchema } from '../models/monitor'
import { SetupFrameSchema, SetupSessionViewSchema } from '../models/setup'

export const MAIN_CAPTURE_IPC_CHANNELS = Object.freeze({
  listSources: 'capture:list-sources',
  prepareSource: 'capture:prepare-source',
  releaseSource: 'capture:release-source',
  startSetup: 'capture:start-setup',
  getStatus: 'capture:get-status',
  getProfiles: 'capture:get-profiles',
  activateProfile: 'capture:activate-profile',
  renameProfile: 'capture:rename-profile',
  duplicateProfile: 'capture:duplicate-profile',
  deleteProfile: 'capture:delete-profile',
  rebindProfile: 'capture:rebind-profile',
})

export const SETUP_IPC_CHANNELS = Object.freeze({
  getSession: 'setup:get-session',
  getFrame: 'setup:get-frame',
  setRegion: 'setup:set-region',
  finish: 'setup:finish',
  analyzeTrigger: 'setup:analyze-trigger',
  review: 'setup:review',
  commit: 'setup:commit',
  cancel: 'setup:cancel',
  close: 'setup:close',
})

export const EmptyCapturePayloadSchema = z.object({}).strict()
export const SourceSnapshotResultSchema = CaptureSourceSnapshotSchema
export const CaptureStatusResultSchema = CaptureStatusSchema
export const CaptureProfilesResultSchema = CaptureProfilesViewSchema
export const CaptureProfileMutationResultSchema = z
  .object({
    profiles: CaptureProfilesViewSchema,
    monitor: MonitorViewSchema,
  })
  .strict()
export const PreviewPayloadSchema = z
  .object({
    sourceKey: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict()
export const CapturePreparationResultSchema = PreviewPayloadSchema.extend({
  preparationId: z.uuid(),
}).strict()
export const ReleasePreparationResultSchema = z.object({ released: z.boolean() }).strict()
export const StartSetupPayloadSchema = z
  .object({
    preparationId: z.uuid(),
    profileId: CaptureProfileIdSchema.nullable(),
    profileName: CaptureProfileNameSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
export const CaptureProfileCommandSchema = z
  .object({
    profileId: CaptureProfileIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict()
export const CaptureProfileNamePayloadSchema = CaptureProfileCommandSchema.extend({
  profileName: CaptureProfileNameSchema,
}).strict()
export const RebindCaptureProfilePayloadSchema = CaptureProfileCommandSchema.extend({
  preparationId: z.uuid(),
}).strict()
export const SetupCommandSchema = z
  .object({
    sessionId: z.uuid(),
    generation: z.number().int().nonnegative(),
  })
  .strict()
export const SetRegionPayloadSchema = SetupCommandSchema.extend({
  region: RegionKindSchema,
  rect: NormalizedRectSchema,
}).strict()
export const SetupSessionResultSchema = SetupSessionViewSchema
export const SetupFrameResultSchema = SetupFrameSchema

export type PreviewPayload = z.infer<typeof PreviewPayloadSchema>
export type CapturePreparationResult = z.infer<typeof CapturePreparationResultSchema>
export type StartSetupPayload = z.infer<typeof StartSetupPayloadSchema>
export type CaptureProfileCommand = z.infer<typeof CaptureProfileCommandSchema>
export type CaptureProfileNamePayload = z.infer<typeof CaptureProfileNamePayloadSchema>
export type RebindCaptureProfilePayload = z.infer<
  typeof RebindCaptureProfilePayloadSchema
>
export type SetupCommand = z.infer<typeof SetupCommandSchema>
export type SetRegionPayload = z.infer<typeof SetRegionPayloadSchema>
