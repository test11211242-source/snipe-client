import type { CaptureProfileSummary } from '../../../../shared/models/capture'

/** One-line source health for a profile; `warn` when the source cannot be used right now. */
export function profileHealth(
  profile: CaptureProfileSummary,
  waitingForSource: boolean,
): { text: string; warn: boolean } {
  if (profile.sourceKind === 'display') return { text: 'экран', warn: false }
  const state = profile.sourceHealth.state
  if (state === 'missing' || (profile.isActive && waitingForSource))
    return { text: 'окно не найдено', warn: true }
  if (state === 'ambiguous') return { text: 'несколько окон', warn: true }
  if (state === 'metadata_unavailable')
    return { text: 'выберите окно заново', warn: true }
  if (state === 'available') return { text: 'окно найдено', warn: false }
  return { text: '', warn: false }
}

/** Extra lines under a profile row, all taken from the fields main reports. */
export interface ProfileNotes {
  /** Source needs to be picked again (identity missing or several windows match). */
  rebind: string | null
  /** Calibration status; `null` when it is validated. */
  calibration: { text: string; warn: boolean } | null
}

export function profileNotes(profile: CaptureProfileSummary): ProfileNotes {
  const state = profile.sourceHealth.state
  return {
    rebind:
      state === 'metadata_unavailable'
        ? 'Требуется перепривязка источника'
        : state === 'ambiguous'
          ? 'Подходит несколько окон — выберите нужное'
          : null,
    calibration:
      profile.calibrationHealth === 'needs_validation'
        ? { text: 'Области нужно проверить заново', warn: true }
        : profile.calibrationHealth === 'imported'
          ? { text: 'Области перенесены из прежней версии', warn: false }
          : null,
  }
}

/** Source states in which result-zone capture cannot take a frame. */
export function sourceUsable(profile: CaptureProfileSummary): boolean {
  const state = profile.sourceHealth.state
  return state === 'available' || state === 'unknown'
}
