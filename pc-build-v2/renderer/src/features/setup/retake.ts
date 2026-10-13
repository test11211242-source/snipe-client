import type { CapturePreparationResult } from '../../../../shared/contracts/capture-ipc'
import type {
  CapturePreference,
  CaptureSourceView,
} from '../../../../shared/models/capture'
import { preparationFailureMessage } from './errors'

export type RetakePreparation =
  { ok: true; preparation: CapturePreparationResult } | { ok: false; message: string }

const NOT_FOUND = 'Не нашли тот же источник. Нажмите «Выбрать окно» и выберите его.'

/** The listed source that is the one the finished session was frozen from, if unambiguous. */
export function findSameSource(
  sources: readonly CaptureSourceView[],
  wanted: CapturePreference,
): CaptureSourceView | null {
  const sameKind = sources.filter(
    (source) => source.captureSupported && source.kind === wanted.kind,
  )
  const labelled = sameKind.filter((source) => source.label === wanted.label)
  if (labelled.length <= 1) return labelled[0] ?? null
  if (wanted.kind !== 'window' || wanted.executableLabel === null) return null
  const executable = labelled.filter((source) => source.detail === wanted.executableLabel)
  return executable.length === 1 ? (executable[0] ?? null) : null
}

/**
 * Lists the sources again and prepares the one the session came from, so that a fresh
 * frame can be frozen without making the user pick it. Never throws: every failure has a
 * text the failure view can show.
 */
export async function prepareSameSource(
  wanted: CapturePreference,
): Promise<RetakePreparation> {
  try {
    const snapshot = await window.crTools.listCaptureSources()
    const source = findSameSource(snapshot.sources, wanted)
    if (source === null) return { ok: false, message: NOT_FOUND }
    const response = await window.crTools.prepareCaptureSource({
      sourceKey: source.sourceKey,
      revision: source.revision,
    })
    return response.ok
      ? { ok: true, preparation: response.preparation }
      : { ok: false, message: preparationFailureMessage(response.error.code) }
  } catch {
    return { ok: false, message: NOT_FOUND }
  }
}
