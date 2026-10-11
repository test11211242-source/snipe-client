import type {
  MonitorPublicErrorLike,
  OpponentPresentation,
  PresentationInput,
} from './types'
import { selectRunPhase } from '../monitor/selectors'

export const SOURCE_REBIND_CODE = 'SOURCE_REBIND_REQUIRED'

function isRebind(error: MonitorPublicErrorLike | null): boolean {
  return error?.code === SOURCE_REBIND_CODE
}

/** True while a search for the current battle is underway (no result yet). */
export function searchInProgress(input: PresentationInput): boolean {
  const phase = input.view?.search?.phase
  return phase === 'capturing' || phase === 'requesting'
}

/**
 * What the opponent card shows. A selected history entry always wins; otherwise the state
 * follows the main-owned monitor view. Nothing here guesses data: repeats, nicknames and
 * retry validity come from structured fields only.
 */
export function selectOpponentPresentation(
  input: PresentationInput,
): OpponentPresentation {
  const { view, hasProfiles, selected, now, summaryDismissed } = input
  if (!hasProfiles) return { kind: 'no-profile' }
  if (selected !== null)
    return { kind: 'result', result: selected, viewing: true, retry: null }

  const phase = selectRunPhase(view, hasProfiles)
  if (view === null) return { kind: 'stopped' }
  if (phase === 'stopping') return { kind: 'stopping' }
  if (phase === 'starting') return { kind: 'starting', readiness: view.readiness }
  if (isRebind(view.error) && view.error !== null)
    return { kind: 'rebind', message: view.error.message }
  if (phase === 'waiting-source') return { kind: 'waiting-source' }
  if (phase === 'failed') return { kind: 'failed', error: view.error }
  if (phase === 'stopped') {
    return view.summary !== null && !summaryDismissed
      ? { kind: 'summary', summary: view.summary }
      : { kind: 'stopped' }
  }

  // Running.
  if (!view.readiness.authenticated) return { kind: 'auth' }
  if (searchInProgress(input))
    return { kind: 'searching', nickname: view.search?.searchedNickname ?? null }
  const latest = input.latest
  if (latest === null) return { kind: 'idle' }
  const search = view.search
  let retry: { attemptId: string; expiresAt: string } | null = null
  const expiresAt = search?.retryExpiresAt ?? null
  if (
    search !== null &&
    expiresAt !== null &&
    latest.kind === 'service_error' &&
    latest.retryable &&
    !latest.authBlocked &&
    latest.attemptId === search.attemptId &&
    Date.parse(expiresAt) > now
  )
    retry = { attemptId: search.attemptId, expiresAt }
  return { kind: 'result', result: latest, viewing: false, retry }
}
