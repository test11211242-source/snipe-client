import { z } from 'zod'

import {
  CaptureSourcePreviewSchema,
  CaptureSourceSnapshotSchema,
  CaptureStatusSchema,
  NormalizedRectSchema,
  RegionKindSchema,
} from '../models/capture'
import { SetupFrameSchema, SetupSessionViewSchema } from '../models/setup'

export const MAIN_CAPTURE_IPC_CHANNELS = Object.freeze({
  listSources: 'capture:list-sources',
  getPreview: 'capture:get-preview',
  startSetup: 'capture:start-setup',
  getStatus: 'capture:get-status',
})

export const SETUP_IPC_CHANNELS = Object.freeze({
  getSession: 'setup:get-session',
  getFrame: 'setup:get-frame',
  setRegion: 'setup:set-region',
  analyzeTrigger: 'setup:analyze-trigger',
  review: 'setup:review',
  commit: 'setup:commit',
  cancel: 'setup:cancel',
  close: 'setup:close',
})

export const EmptyCapturePayloadSchema = z.object({}).strict()
export const SourceSnapshotResultSchema = CaptureSourceSnapshotSchema
export const CaptureStatusResultSchema = CaptureStatusSchema
export const PreviewPayloadSchema = z
  .object({
    sourceKey: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict()
export const PreviewResultSchema = CaptureSourcePreviewSchema
export const StartSetupPayloadSchema = PreviewPayloadSchema
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
export type StartSetupPayload = z.infer<typeof StartSetupPayloadSchema>
export type SetupCommand = z.infer<typeof SetupCommandSchema>
export type SetRegionPayload = z.infer<typeof SetRegionPayloadSchema>
