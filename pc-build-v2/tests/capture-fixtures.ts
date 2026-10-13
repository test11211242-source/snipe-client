import {
  CaptureConfigurationSchema,
  type CaptureConfiguration,
  type FullFrameCalibration,
} from '../shared/models/capture'
import {
  createLayoutCalibration,
  LegacyCaptureConfigurationSchema,
} from '../electron/main/infrastructure/capture-profile-migration'
import { captureConfigurationFingerprint } from '../electron/main/infrastructure/capture-configuration-repository'

export function v4CaptureFixture(
  input: unknown,
): CaptureConfiguration & { calibration: FullFrameCalibration } {
  const legacy = LegacyCaptureConfigurationSchema.parse(input)
  const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
    schemaVersion: 3,
    userId: legacy.userId,
    revision: legacy.revision,
    committedAt: legacy.committedAt,
    sourceBinding: { identity: legacy.source, lastVerifiedAt: null },
    calibration: createLayoutCalibration(
      '00000000-0000-4000-8000-000000000001',
      legacy.revision,
      legacy.frameSize,
      {
        trigger: legacy.regions.trigger,
        nickname: legacy.regions.normal,
        topLeftEvidence: legacy.regions.precise,
      },
      legacy.triggerProfile,
      legacy.committedAt,
      'manual',
    ),
  }
  const parsed = CaptureConfigurationSchema.parse({
    ...unsigned,
    fingerprint: captureConfigurationFingerprint(unsigned),
  })
  if (parsed.calibration.coordinateSpace !== 'full_frame_normalized') {
    throw new Error('Expected a full-frame synthetic fixture')
  }
  return { ...parsed, calibration: parsed.calibration }
}
