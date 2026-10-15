import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { MonitorProcessEventSchema } from '../shared/contracts/monitor-protocol'

const eventsFile = process.env['CR_C3_EVENTS_JSONL']

// Opt-in: the image-free events the Python worker path emitted in the C3
// replay (`m9_replay.py c3`, `wired-events.jsonl` in its external output).
describe.skipIf(eventsFile === undefined)(
  'C3 replay events against the monitor contract',
  () => {
    it('parses every emitted triggered and prediction_result event', () => {
      const lines = readFileSync(eventsFile ?? '', 'utf8')
        .split('\n')
        .filter(Boolean)
      const events = lines.map((line) =>
        MonitorProcessEventSchema.parse(JSON.parse(line)),
      )
      const triggered = events.filter((event) => event.type === 'triggered')
      const results = events.filter((event) => event.type === 'prediction_result')
      expect(triggered.length).toBeGreaterThan(0)
      expect(results.length).toBeGreaterThan(0)
      for (const event of triggered) {
        expect(event.payload.rankEvidence === null).toBe(event.payload.kind !== 'battle')
      }
      const ownBattles = new Set(
        triggered
          .filter((event) => event.payload.kind === 'battle')
          .map((event) => event.payload.triggerId),
      )
      for (const event of results) {
        expect(ownBattles.has(event.payload.battleId ?? '')).toBe(true)
      }
    })
  },
)
