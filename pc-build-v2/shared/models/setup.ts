import { z } from 'zod'

import { PublicErrorSchema } from '../errors/application-error'
import {
  CapturePreferenceSchema,
  CaptureProfileIdSchema,
  CaptureProfileNameSchema,
  NormalizedRectSchema,
  NormalizedRegionsSchema,
  PixelSizeSchema,
  RegionKindSchema,
  TriggerProfileSchema,
} from './capture'

export const SetupStateSchema = z.enum([
  'CREATED',
  'CAPTURING',
  'SELECTING',
  'ANALYZING',
  'REVIEW',
  'SAVING',
  'COMMITTED',
  'CANCELLED',
  'FAILED',
])

export const SetupSessionViewSchema = z
  .object({
    kind: z.enum(['capture', 'predictionResult']).default('capture'),
    sessionId: z.uuid(),
    generation: z.number().int().nonnegative(),
    state: SetupStateSchema,
    source: CapturePreferenceSchema,
    profileId: CaptureProfileIdSchema.nullable().default(null),
    profileName: CaptureProfileNameSchema.nullable().default(null),
    frameSize: PixelSizeSchema.nullable(),
    regions: z
      .object({
        trigger: NormalizedRectSchema.nullable(),
        normal: NormalizedRectSchema.nullable(),
        precise: NormalizedRectSchema.nullable(),
        resultTrigger: NormalizedRectSchema.nullable().default(null),
        resultData: NormalizedRectSchema.nullable().default(null),
      })
      .strict(),
    triggerProfile: TriggerProfileSchema.nullable(),
    error: PublicErrorSchema.nullable(),
  })
  .strict()

export const SetupFrameSchema = z
  .object({
    sessionId: z.uuid(),
    generation: z.number().int().nonnegative(),
    size: PixelSizeSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
    mimeType: z.literal('image/png'),
    bytes: z.instanceof(Uint8Array),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.bytes.byteLength !== frame.byteLength) {
      context.addIssue({ code: 'custom', message: 'byteLength does not match bytes' })
    }
  })

export const LegacyPixelRectSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()

export const LegacyOcrRegionsSchema = z
  .object({
    schema_version: z.literal(2),
    capture_reference: z
      .object({
        target_type: z.enum(['window', 'screen']),
        target_id: z.string().min(1).max(300),
        target_name: z.string().min(1).max(300),
        source_frame_size: PixelSizeSchema,
        selected_target: z
          .object({
            targetType: z.enum(['window', 'screen']),
            name: z.string().min(1).max(300),
            executableName: z.string().min(1).max(120).nullable(),
          })
          .strict(),
        created_at: z.iso.datetime(),
      })
      .strict(),
    trigger_area: LegacyPixelRectSchema.extend({
      ratio: NormalizedRectSchema,
      trigger_profile: z
        .object({
          schema_version: z.literal(2),
          outer_ratio: NormalizedRectSchema,
          inner_ratio: NormalizedRectSchema,
          template_gray_base64: z.string().min(1),
          thumbnail_hash: z.string().regex(/^[a-f0-9]{16}$/),
          hash_algorithm: z.literal('ahash64-bitwise-v1'),
          feature_mode: z.enum(['orb', 'ncc']),
          keypoints_count: z.number().int().nonnegative(),
          normalized_template_size: PixelSizeSchema,
          hash_threshold: z.number().int().min(0).max(64),
          orb_distance_threshold: z.number().int().positive(),
          orb_min_good_matches: z.number().int().nonnegative(),
          ncc_threshold: z.number().min(-1).max(1),
          analyzer_version: z.string().min(1),
        })
        .strict(),
    }).strict(),
    normal_data_area: LegacyPixelRectSchema.extend({
      ratio: NormalizedRectSchema,
    }).strict(),
    precise_data_area: LegacyPixelRectSchema.extend({
      ratio: NormalizedRectSchema,
    }).strict(),
    screen_resolution: PixelSizeSchema,
    updated_at: z.iso.datetime(),
  })
  .strict()

export type SetupState = z.infer<typeof SetupStateSchema>
export type SetupSessionView = z.infer<typeof SetupSessionViewSchema>
export type SetupFrame = z.infer<typeof SetupFrameSchema>
export type LegacyOcrRegions = z.infer<typeof LegacyOcrRegionsSchema>
export { NormalizedRegionsSchema, RegionKindSchema }
