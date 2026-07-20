import { z } from 'zod'

import {
  CaptureProfileIdSchema,
  CapturePreferenceSchema,
  NormalizedRectSchema,
  PixelSizeSchema,
  TriggerProfileSchema,
} from './capture'

export const PredictionResultConfigurationSchema = z
  .object({
    schemaVersion: z.literal(2),
    userId: z.string().min(1).max(128),
    captureProfileId: CaptureProfileIdSchema,
    captureConfigurationRevision: z.number().int().positive(),
    captureConfigurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
    committedAt: z.iso.datetime(),
    source: CapturePreferenceSchema,
    frameSize: PixelSizeSchema,
    trigger: NormalizedRectSchema,
    data: NormalizedRectSchema,
    triggerProfile: TriggerProfileSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const PredictionRuntimeProfileSchema = z
  .object({
    configuredFrameSize: PixelSizeSchema,
    trigger: NormalizedRectSchema,
    data: NormalizedRectSchema,
    triggerProfile: TriggerProfileSchema,
  })
  .strict()

export type PredictionResultConfiguration = z.infer<
  typeof PredictionResultConfigurationSchema
>
export type PredictionRuntimeProfile = z.infer<typeof PredictionRuntimeProfileSchema>

export function predictionResultMatchesCapture(
  result: PredictionResultConfiguration,
  capture: {
    profileId: string
    configurationRevision: number
    configurationFingerprint: string
  },
): boolean {
  return (
    result.captureProfileId === capture.profileId &&
    result.captureConfigurationRevision === capture.configurationRevision &&
    result.captureConfigurationFingerprint === capture.configurationFingerprint
  )
}
