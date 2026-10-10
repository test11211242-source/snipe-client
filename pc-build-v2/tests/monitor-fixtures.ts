import { MonitorViewSchema, type MonitorView } from '../shared/models/monitor'

export function monitorViewFixture(patch: Partial<MonitorView> = {}): MonitorView {
  return MonitorViewSchema.parse({
    state: 'STOPPED',
    preferences: { deckMode: 'pol' },
    readiness: { authenticated: true, captureConfigured: true, sourceAvailable: true },
    error: null,
    startedAt: null,
    stats: {
      triggers: 0,
      requests: 0,
      droppedActions: 0,
      playersFound: 0,
      playersNotFound: 0,
      recognitionFailures: 0,
      serviceErrors: 0,
    },
    results: [],
    ...patch,
  })
}
