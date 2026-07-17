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
      windowHwnd: z
        .string()
        .regex(/^[1-9]\d{0,18}$/)
        .optional(),
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

export const MAX_CAPTURE_PROFILES = 20

export const CaptureProfileIdSchema = z.uuid()
export const CaptureProfileNameSchema = z.string().trim().min(1).max(80)

export const CaptureProfileSchema = z
  .object({
    profileId: CaptureProfileIdSchema,
    profileName: CaptureProfileNameSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    configuration: CaptureConfigurationSchema,
  })
  .strict()

export const CaptureProfileCollectionSchema = z
  .object({
    schemaVersion: z.literal(2),
    userId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    activeProfileId: CaptureProfileIdSchema,
    profiles: z.array(CaptureProfileSchema).min(1).max(MAX_CAPTURE_PROFILES),
  })
  .strict()
  .superRefine((collection, context) => {
    const profileIds = new Set<string>()
    const profileNames = new Set<string>()
    let activeProfileCount = 0

    for (const [index, profile] of collection.profiles.entries()) {
      if (profileIds.has(profile.profileId)) {
        context.addIssue({
          code: 'custom',
          message: 'Profile IDs must be unique',
          path: ['profiles', index, 'profileId'],
        })
      }
      profileIds.add(profile.profileId)

      const normalizedName = profile.profileName.toLowerCase()
      if (profileNames.has(normalizedName)) {
        context.addIssue({
          code: 'custom',
          message: 'Profile names must be unique ignoring case',
          path: ['profiles', index, 'profileName'],
        })
      }
      profileNames.add(normalizedName)

      if (profile.profileId === collection.activeProfileId) activeProfileCount += 1
      if (profile.configuration.userId !== collection.userId) {
        context.addIssue({
          code: 'custom',
          message: 'Profile configuration userId must match collection userId',
          path: ['profiles', index, 'configuration', 'userId'],
        })
      }
    }

    if (activeProfileCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'activeProfileId must identify exactly one profile',
        path: ['activeProfileId'],
      })
    }
  })

export const CaptureProfileSummarySchema = z
  .object({
    profileId: CaptureProfileIdSchema,
    profileName: CaptureProfileNameSchema,
    isActive: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    configurationRevision: z.number().int().positive(),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    committedAt: z.iso.datetime(),
    sourceKind: CaptureSourceKindSchema,
    sourceLabel: z.string().min(1).max(300),
  })
  .strict()

export const CaptureProfileCollectionStatusSchema = z
  .object({
    userId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    activeProfileId: CaptureProfileIdSchema,
    profileCount: z.number().int().min(1).max(MAX_CAPTURE_PROFILES),
    profiles: z.array(CaptureProfileSummarySchema).min(1).max(MAX_CAPTURE_PROFILES),
  })
  .strict()
  .superRefine((status, context) => {
    if (status.profileCount !== status.profiles.length) {
      context.addIssue({
        code: 'custom',
        message: 'profileCount must match profiles length',
        path: ['profileCount'],
      })
    }
    const activeProfiles = status.profiles.filter(
      (profile) => profile.profileId === status.activeProfileId && profile.isActive,
    )
    if (
      activeProfiles.length !== 1 ||
      status.profiles.some(
        (profile) => profile.profileId !== status.activeProfileId && profile.isActive,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly the active profile must have isActive set',
        path: ['profiles'],
      })
    }
  })

export const CaptureProfilesViewSchema = z
  .object({
    revision: z.number().int().positive().nullable(),
    activeProfileId: CaptureProfileIdSchema.nullable(),
    profiles: z.array(CaptureProfileSummarySchema).max(MAX_CAPTURE_PROFILES),
  })
  .strict()
  .superRefine((view, context) => {
    if (
      (view.profiles.length === 0 &&
        (view.revision !== null || view.activeProfileId !== null)) ||
      (view.profiles.length > 0 &&
        (view.revision === null ||
          view.activeProfileId === null ||
          !view.profiles.some(
            (profile) => profile.profileId === view.activeProfileId && profile.isActive,
          )))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Capture profile view active state is invalid',
        path: ['activeProfileId'],
      })
    }
  })

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
export type CaptureProfile = z.infer<typeof CaptureProfileSchema>
export type CaptureProfileCollection = z.infer<typeof CaptureProfileCollectionSchema>
export type CaptureProfileSummary = z.infer<typeof CaptureProfileSummarySchema>
export type CaptureProfileCollectionStatus = z.infer<
  typeof CaptureProfileCollectionStatusSchema
>
export type CaptureProfilesView = z.infer<typeof CaptureProfilesViewSchema>
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>
