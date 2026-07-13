import type { CapturePreference, CaptureSourceView } from '../../../shared/models/capture'

export type SetupCaptureSelector =
  | { kind: 'window'; windowHwnd: string }
  | { kind: 'display'; displayDeviceName: string; electronDisplayId: string }

export interface ResolvedCaptureSource {
  view: CaptureSourceView
  selector: SetupCaptureSelector
  preference: CapturePreference
}
