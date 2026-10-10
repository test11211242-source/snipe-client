import { useEffect, useState } from 'react'

import type { H2HLookupResult } from '../../../../shared/contracts/h2h'
import { GameAccountTagSchema } from '../../../../shared/models/streamer'

export type H2HData = Extract<H2HLookupResult, { capability: 'supported' }>['data']

export type H2HState =
  /** No tag to ask about: nothing is requested. */
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** Authoritative server answer: status ok | none | no_accounts | unavailable. */
  | { kind: 'data'; data: H2HData }
  /** Transport-level outcome: rate limited, old server without the endpoint, failure. */
  | { kind: 'unavailable'; reason: 'rate_limited' | 'unsupported' | 'failed' }

type Outcome = Exclude<H2HState, { kind: 'idle' | 'loading' }>

function toOutcome(result: H2HLookupResult): Outcome {
  switch (result.capability) {
    case 'supported':
      return { kind: 'data', data: result.data }
    case 'rate_limited':
      return { kind: 'unavailable', reason: 'rate_limited' }
    case 'unsupported':
      return { kind: 'unavailable', reason: 'unsupported' }
    case 'unavailable':
    case 'cancelled':
      return { kind: 'unavailable', reason: 'failed' }
  }
}

/** Canonical `#TAG` or null for a missing/invalid tag. */
export function canonicalTag(tag: string | null): string | null {
  if (tag === null) return null
  const parsed = GameAccountTagSchema.safeParse(tag)
  return parsed.success ? parsed.data : null
}

export interface H2HLookup {
  state: H2HState
  /** Asks again after an unavailable outcome. */
  retry: () => void
}

interface Stored {
  tag: string
  attempt: number
  outcome: Outcome
}

/**
 * Head-to-head record against `tag` (canonical or raw). A fresh request id is created per
 * request; a changed tag or unmount cancels the request in main and discards its answer.
 */
export function useH2H(tag: string | null): H2HLookup {
  const canonical = canonicalTag(tag)
  const [attempt, setAttempt] = useState(0)
  const [stored, setStored] = useState<Stored | null>(null)

  useEffect(() => {
    if (canonical === null) return
    const requestId = crypto.randomUUID()
    let active = true
    void window.crTools.h2h
      .lookup({ requestId, opponentTag: canonical })
      .then(
        (result) => toOutcome(result),
        (): Outcome => ({ kind: 'unavailable', reason: 'failed' }),
      )
      .then((outcome) => {
        if (active) setStored({ tag: canonical, attempt, outcome })
      })
    return () => {
      active = false
      void Promise.resolve(window.crTools.h2h.cancel({ requestId })).catch(
        () => undefined,
      )
    }
  }, [canonical, attempt])

  const state: H2HState =
    canonical === null
      ? { kind: 'idle' }
      : stored?.tag === canonical && stored.attempt === attempt
        ? stored.outcome
        : { kind: 'loading' }
  return { state, retry: () => setAttempt((current) => current + 1) }
}
