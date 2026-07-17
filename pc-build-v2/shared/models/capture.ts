import { z } from 'zod'

export const PixelSizeSchema = z
  .object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  })
  .strict()

export const NormalizedRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .superRefine((rect, context) => {
    if (rect.x + rect.width > 1 + Number.EPSILON) {
      context.addIssue({
        code: 'custom',
        message: 'x + width must be <= 1',
        path: ['width'],
      })
    }
    if (rect.y + rect.height > 1 + Number.EPSILON) {
      context.addIssue({
        code: 'custom',
        message: 'y + height must be <= 1',
        path: ['height'],
      })
    }
  })

export const CaptureSourceKindSchema = z.enum(['window', 'display'])

export const CaptureSourcePreviewDataSchema = z
  .object({
    size: PixelSizeSchema,
    dataUrl: z
      .string()
      .regex(/^data:image\/(?:jpeg|png);base64,/)
      .max(699_100),
  })
  .strict()

export const CaptureSourceViewSchema = z
  .object({
    sourceKey: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
    kind: CaptureSourceKindSchema,
    label: z.string().min(1).max(300),
    detail: z.string().min(1).max(300).nullable(),
    captureSupported: z.boolean(),
    unavailableReason: z.string().min(1).max(300).nullable(),
    preview: CaptureSourcePreviewDataSchema.nullable(),
  })
  .strict()

export const CaptureSourceSnapshotSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{32}$/),
    expiresAt: z.number().int().positive(),
    sources: z.array(CaptureSourceViewSchema).max(256),
  })
  .strict()

export const CaptureSourcePreviewSchema = z
  .object({
    sourceKey: z.string().regex(/^[a-f0-9]{32}$/),
    revision: z.string().regex(/^[a-f0-9]{32}$/),
    size: PixelSizeSchema,
    dataUrl: z.string().startsWith('data:image/png;base64,').max(1_398_200),
  })
  .strict()

export const RegionKindSchema = z.enum([
  'trigger',
  'normal',
  'precise',
  'resultTrigger',
  'resultData',
])
export const NormalizedRegionsSchema = z
  .object({
    trigger: NormalizedRectSchema,
    normal: NormalizedRectSchema,
    precise: NormalizedRectSchema,
  })
  .strict()

export const TriggerProfileSchema = z
  .object({
    schemaVersion: z.literal(2),
    analyzer: z
      .object({
        name: z.literal('cr-tools-trigger-analyzer'),
        version: z.string().min(1).max(32),
      })
      .strict(),
    hashAlgorithm: z.literal('ahash64-bitwise-v1'),
    ahash64: z.string().regex(/^[a-f0-9]{16}$/),
    innerRect: NormalizedRectSchema,
    featureMode: z.enum(['orb', 'ncc']),
    keypointsCount: z.number().int().nonnegative().max(100_000),
    normalizedTemplateSize: PixelSizeSchema,
    templateGrayBase64: z
      .string()
      .min(1)
      .max(128 * 128 * 2),
    hashMaxDistance: z.number().int().min(0).max(64),
    orbDistanceThreshold: z.number().int().positive().max(256),
    orbMinGoodMatches: z.number().int().nonnegative().max(10_000),
    nccMinScore: z.number().min(-1).max(1),
  })
  .strict()

export const CapturePreferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('window'),
      label: z.string().min(1).max(300),
      titleHint: z.string().min(1).max(300),
      executableLabel: z.string().min(1).max(120).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('display'),
      label: z.string().min(1).max(300),
      displayId: z.string().min(1).max(128),
    })
    .strict(),
])

export const CaptureConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    committedAt: z.iso.datetime(),
    source: CapturePreferenceSchema,
    frameSize: PixelSizeSchema,
    regions: NormalizedRegionsSchema,
    triggerProfile: TriggerProfileSchema,
  })
  .strict()

export const CaptureStatusSchema = z
  .object({
    configured: z.boolean(),
    revision: z.number().int().positive().nullable(),
    sourceLabel: z.string().min(1).max(300).nullable(),
  })
  .strict()

export type PixelSize = z.infer<typeof PixelSizeSchema>
export type NormalizedRect = z.infer<typeof NormalizedRectSchema>
export type CaptureSourceView = z.infer<typeof CaptureSourceViewSchema>
export type CaptureSourcePreviewData = z.infer<typeof CaptureSourcePreviewDataSchema>
export type CaptureSourceSnapshot = z.infer<typeof CaptureSourceSnapshotSchema>
export type CaptureSourcePreview = z.infer<typeof CaptureSourcePreviewSchema>
export type RegionKind = z.infer<typeof RegionKindSchema>
export type NormalizedRegions = z.infer<typeof NormalizedRegionsSchema>
export type TriggerProfile = z.infer<typeof TriggerProfileSchema>
export type CapturePreference = z.infer<typeof CapturePreferenceSchema>
export type CaptureConfiguration = z.infer<typeof CaptureConfigurationSchema>
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>
