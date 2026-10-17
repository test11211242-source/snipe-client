import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CapturePreferenceSchema,
  CaptureProfileCollectionSchema,
  CaptureConfigurationSchema,
  FullFrameCalibrationSchema,
  CaptureProfileSchema,
  NormalizedRectSchema,
  PixelSizeSchema,
  TriggerProfileSchema,
  type GameLayout,
  type NormalizedRegions,
  type PixelSize,
  type TriggerProfile,
} from '../../../shared/models/capture'

export const LegacyCaptureConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    committedAt: z.iso.datetime(),
    source: CapturePreferenceSchema,
    frameSize: PixelSizeSchema,
    regions: z
      .object({
        trigger: NormalizedRectSchema,
        normal: NormalizedRectSchema,
        precise: NormalizedRectSchema,
      })
      .strict(),
    triggerProfile: TriggerProfileSchema,
  })
  .strict()
export type LegacyCaptureConfiguration = z.infer<typeof LegacyCaptureConfigurationSchema>

export const LegacyCaptureCollectionSchema = z
  .object({
    ...CaptureProfileCollectionSchema.shape,
    schemaVersion: z.literal(2),
    profiles: z
      .array(
        z
          .object({
            profileId: z.uuid(),
            profileName: z.string().trim().min(1).max(80),
            createdAt: z.iso.datetime(),
            updatedAt: z.iso.datetime(),
            configuration: LegacyCaptureConfigurationSchema,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()

/** Exact rollback v4 schemas: no game-relative fields or newer versions accepted. */
export const V4LayoutCalibrationSchema = FullFrameCalibrationSchema.extend({
  schemaVersion: z.literal(1),
})
export const V4CaptureConfigurationSchema = CaptureConfigurationSchema.extend({
  schemaVersion: z.literal(2),
  calibration: V4LayoutCalibrationSchema,
})
export const V4CaptureCollectionSchema = z
  .object({
    ...CaptureProfileCollectionSchema.shape,
    schemaVersion: z.literal(3),
    profiles: z
      .array(
        CaptureProfileSchema.extend({
          configuration: V4CaptureConfigurationSchema,
        }),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((collection, context) => {
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const [index, profile] of collection.profiles.entries()) {
      const name = profile.profileName.toLowerCase()
      if (ids.has(profile.profileId) || names.has(name)) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index],
          message: 'Duplicate capture profile',
        })
      }
      ids.add(profile.profileId)
      names.add(name)
      if (profile.configuration.userId !== collection.userId) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index, 'configuration', 'userId'],
          message: 'Capture user does not match',
        })
      }
    }
    if (!ids.has(collection.activeProfileId)) {
      context.addIssue({
        code: 'custom',
        path: ['activeProfileId'],
        message: 'Active capture profile does not exist',
      })
    }
  })
export type V4CaptureCollection = z.infer<typeof V4CaptureCollectionSchema>
export type V4CaptureProfile = V4CaptureCollection['profiles'][number]
export function assertLegacyFingerprint(value: { fingerprint: string }): void {
  const { fingerprint, ...unsigned } = value
  if (
    createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') !== fingerprint
  ) {
    throw new Error('Legacy capture fingerprint is invalid')
  }
}

export function createLayoutCalibration(
  id: string,
  revision: number,
  frameSize: PixelSize,
  regions: NormalizedRegions,
  triggerProfile: TriggerProfile,
  calibratedAt: string,
  origin: 'manual' | 'imported',
): z.infer<typeof FullFrameCalibrationSchema> {
  const provenance = { origin, confidence: null, analyzerVersion: null }
  return {
    schemaVersion: 2,
    calibrationId: id,
    revision,
    referenceFrameSize: frameSize,
    coordinateSpace: 'full_frame_normalized',
    gameViewport: null,
    expectedLayout: null,
    triggerRegion: regions.trigger,
    nicknameRegion: regions.nickname,
    topLeftEvidenceRegion: regions.topLeftEvidence,
    triggerProfile,
    provenance: {
      trigger: { ...provenance, analyzerVersion: triggerProfile.analyzer.version },
      nickname: { ...provenance },
      topLeftEvidence: { ...provenance },
      viewport: { origin, confidence: null, analyzerVersion: null },
    },
    validationStatus: origin === 'imported' ? 'imported' : 'validated',
    calibratedAt,
  }
}

const CHROME_SIDES = ['top', 'bottom', 'left', 'right'] as const
const PHANTOM_RECT_TOLERANCE_PX = 2

/**
 * A learned layout is a proven phantom-chrome layout when some window-chrome
 * side has a thickness but no edge template (only an inferred band produces
 * that) and its game rect, grown back by exactly those template-less sides, is
 * a setup layout's game rect in the same reference frame. It is then the setup
 * game seen through a band that was never chrome (owner MuMu F11, 14.10.2026:
 * 0.5488 = the 0.5794 game minus a phantom 57-px left band). Real chrome grown
 * back never reproduces the setup game rect, so such layouts are kept.
 */
export function isPhantomChromeLayout(
  layout: GameLayout,
  layouts: readonly GameLayout[],
): boolean {
  if (layout.layoutSource !== 'learned') return false
  const chrome = layout.windowChrome
  const band = (side: (typeof CHROME_SIDES)[number]): number =>
    chrome[side] > 0 && chrome[`${side}Edges`] === null ? chrome[side] : 0
  if (CHROME_SIDES.every((side) => band(side) === 0)) return false
  const rect = layout.referenceGameRect
  const grown = {
    x: rect.x - band('left'),
    y: rect.y - band('top'),
    width: rect.width + band('left') + band('right'),
    height: rect.height + band('top') + band('bottom'),
  }
  return layouts.some(
    (setup) =>
      setup.layoutSource === 'setup' &&
      setup.referenceFrameSize.width === layout.referenceFrameSize.width &&
      setup.referenceFrameSize.height === layout.referenceFrameSize.height &&
      (['x', 'y', 'width', 'height'] as const).every(
        (key) =>
          Math.abs(setup.referenceGameRect[key] - grown[key]) <=
          PHANTOM_RECT_TOLERANCE_PX,
      ),
  )
}
