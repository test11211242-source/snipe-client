/**
 * Idempotency of manual prediction presses. One intent is the account, the shown
 * prediction, its shown wins and the chosen outcome; its request ID lives until the
 * authoritative view shows another prediction or other wins (a new key), so a repeat after
 * a lost response, a failed status refresh or an accepted-but-uncounted answer is
 * deduplicated by the server. Only a confirmed «Бой не считается» ends its intent early:
 * a skip never changes the shown progress, and the next battle may need a skip of its own.
 * Module-scoped (memory only) so the intent survives leaving the page or the stream area.
 */
let intent: { key: string; requestIds: Map<string, string> } | null = null

/** Each outcome keeps its ID within the displayed account/prediction/progress. */
export function manualRequestId(key: string, outcome: string): string {
  if (intent?.key !== key) intent = { key, requestIds: new Map() }
  let requestId = intent.requestIds.get(outcome)
  if (requestId === undefined) {
    requestId = crypto.randomUUID()
    intent.requestIds.set(outcome, requestId)
  }
  return requestId
}

/** The server confirmed the skip `key`: an identical later press is a new battle. */
export function confirmManualIntent(key: string, outcome: string): void {
  if (intent?.key === key) intent.requestIds.delete(outcome)
}
