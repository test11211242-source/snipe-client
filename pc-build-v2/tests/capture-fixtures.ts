import {
  CaptureConfigurationSchema,
  type CaptureConfiguration,
} from '../shared/models/capture'
import {
  createLayoutCalibration,
  LegacyCaptureConfigurationSchema,
} from '../electron/main/infrastructure/capture-profile-migration'
import { captureConfigurationFingerprint } from '../electron/main/infrastructure/capture-configuration-repository'

export function v4CaptureFixture(input: unknown): CaptureConfiguration {
  const legacy = LegacyCaptureConfigurationSchema.parse(input)
  const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
    schemaVersion: 2,
    userId: legacy.userId,
    revision: legacy.revision,
    committedAt: legacy.committedAt,
    sourceBinding: { identity: legacy.source, lastVerifiedAt: null },
    calibration: createLayoutCalibration(
      '00000000-0000-4000-8000-000000000001',
      legacy.revision,
      legacy.frameSize,
      legacy.regions,
      legacy.triggerProfile,
      legacy.committedAt,
      'manual',
    ),
  }
  return CaptureConfigurationSchema.parse({
    ...unsigned,
    fingerprint: captureConfigurationFingerprint(unsigned),
  })
}
