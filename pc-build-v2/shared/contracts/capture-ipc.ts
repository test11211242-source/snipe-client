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
import { PublicErrorSchema } from '../errors/application-error'
import { DetectionPreviewSchema } from './auto-setup'

export const MAIN_CAPTURE_IPC_CHANNELS = Object.freeze({
  listSources: 'capture:list-sources',
  loadPreviews: 'capture:load-previews',
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
  retryDetection: 'setup:retry-detection',
  switchToManual: 'setup:switch-to-manual',
  getDetectionPreview: 'setup:get-detection-preview',
  setRegion: 'setup:set-region',
  finish: 'setup:finish',
  analyzeTrigger: 'setup:analyze-trigger',
  review: 'setup:review',
  commit: 'setup:commit',
  cancel: 'setup:cancel',
  retrySync: 'setup:retry-sync',
  close: 'setup:close',
})

export const EmptyCapturePayloadSchema = z.object({}).strict()
export const SourceSnapshotResultSchema = CaptureSourceSnapshotSchema
export const SourcePreviewsPayloadSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict()
export const CaptureStatusResultSchema = CaptureStatusSchema
export const CaptureProfilesResultSchema = CaptureProfilesViewSchema
export const CaptureProfileMutationResultSchema = z
  .object({
    profiles: CaptureProfilesViewSchema,
    monitor: MonitorViewSchema,
    capture: CaptureStatusSchema,
  })
  .strict()
export const CaptureProfileErrorCodeSchema = z.enum([
  'CAPTURE_PROFILE_NAME_CONFLICT',
  'CAPTURE_PROFILE_LIMIT',
  'CAPTURE_PROFILE_STALE',
  'CAPTURE_PROFILE_LAST',
  'CAPTURE_PROFILE_NOT_FOUND',
  'CAPTURE_PROFILE_GEOMETRY_MISMATCH',
  'CAPTURE_PROFILE_SOURCE_UNAVAILABLE',
  'SOURCE_NOT_FOUND',
  'SOURCE_AMBIGUOUS',
  'SOURCE_REBIND_REQUIRED',
  'AUTH_REQUIRED',
  'AUTH_CONTEXT_CHANGED',
  'CAPTURE_PREPARATION_STALE',
  'CAPTURE_PREPARATION_FAILED',
  'UNKNOWN',
])
export type CaptureProfileErrorCode = z.infer<typeof CaptureProfileErrorCodeSchema>
export const CaptureProfileCommandResultSchema = z.discriminatedUnion('ok', [
  CaptureProfileMutationResultSchema.extend({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: CaptureProfileErrorCodeSchema }).strict(),
    })
    .strict(),
])
export type CaptureProfileCommandResult = z.infer<
  typeof CaptureProfileCommandResultSchema
>
export const PreviewPayloadSchema = z
  .object({
    sourceKey: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict()
export const CapturePreparationResultSchema = PreviewPayloadSchema.extend({
  preparationId: z.uuid(),
}).strict()
export const CapturePreparationResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      preparation: CapturePreparationResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: PublicErrorSchema,
    })
    .strict(),
])
export const ReleasePreparationResultSchema = z.object({ released: z.boolean() }).strict()
export const StartSetupPayloadSchema = z
  .object({
    mode: z.enum(['manual', 'auto']),
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
export const RetryDetectionResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), session: SetupSessionResultSchema }).strict(),
  z.object({ ok: z.literal(false), error: PublicErrorSchema }).strict(),
])
export const SetupFrameResultSchema = SetupFrameSchema
export const DetectionPreviewPayloadSchema = z.object({ sessionId: z.uuid() }).strict()
export const DetectionPreviewResultSchema = DetectionPreviewSchema.nullable()

export type PreviewPayload = z.infer<typeof PreviewPayloadSchema>
export type CapturePreparationResult = z.infer<typeof CapturePreparationResultSchema>
export type CapturePreparationResponse = z.infer<typeof CapturePreparationResponseSchema>
export type StartSetupPayload = z.infer<typeof StartSetupPayloadSchema>
export type CaptureProfileCommand = z.infer<typeof CaptureProfileCommandSchema>
export type CaptureProfileNamePayload = z.infer<typeof CaptureProfileNamePayloadSchema>
export type RebindCaptureProfilePayload = z.infer<
  typeof RebindCaptureProfilePayloadSchema
>
export type SetupCommand = z.infer<typeof SetupCommandSchema>
export type SetRegionPayload = z.infer<typeof SetRegionPayloadSchema>
export type DetectionPreviewPayload = z.infer<typeof DetectionPreviewPayloadSchema>
