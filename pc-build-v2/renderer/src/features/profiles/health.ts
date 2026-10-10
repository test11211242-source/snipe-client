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
