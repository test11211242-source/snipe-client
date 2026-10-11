import type {
  MonitorResult,
  MonitorSession,
  MonitorView,
} from '../../../../shared/models/monitor'

export interface MonitorPublicErrorLike {
  code: string
  message: string
}

export interface PresentationInput {
  view: MonitorView | null
  hasProfiles: boolean
  /** History entry the user opened, or null for the live card. */
  selected: MonitorResult | null
  /** Newest result shown by the live card, or null. */
  latest: MonitorResult | null
  /** Epoch ms used to judge retry validity. */
  now: number
  summaryDismissed: boolean
}

export type OpponentPresentation =
  | { kind: 'no-profile' }
  | { kind: 'starting'; readiness: MonitorView['readiness'] }
  | { kind: 'stopping' }
  | { kind: 'waiting-source' }
  | { kind: 'rebind'; message: string }
  | { kind: 'failed'; error: MonitorPublicErrorLike | null }
  | { kind: 'stopped' }
  | { kind: 'summary'; summary: MonitorSession }
  | { kind: 'auth' }
  | { kind: 'idle' }
  | { kind: 'searching'; nickname: string | null }
  | {
      kind: 'result'
      result: MonitorResult
      /** A past entry opened from the history. */
      viewing: boolean
      /** Valid retry of the displayed service error, or null. */
      retry: { attemptId: string; expiresAt: string } | null
    }
