import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CapturePreferenceSchema,
  CaptureProfileCollectionSchema,
  NormalizedRectSchema,
  PixelSizeSchema,
  TriggerProfileSchema,
  type LayoutCalibration,
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
): LayoutCalibration {
  const provenance = { origin, confidence: null, analyzerVersion: null }
  return {
    schemaVersion: 1,
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
