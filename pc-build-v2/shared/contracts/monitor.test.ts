import { describe, expect, it } from 'vitest'

import { MonitorPreferencesPayloadSchema, MonitorViewResultSchema } from './monitor-ipc'

describe('monitor renderer contracts', () => {
  it('accepts only the two monitor preference enums', () => {
    expect(
      MonitorPreferencesPayloadSchema.parse({ searchMode: 'fast', deckMode: 'pol' }),
    ).toEqual({
      searchMode: 'fast',
      deckMode: 'pol',
    })
    expect(() =>
      MonitorPreferencesPayloadSchema.parse({
        searchMode: 'fast',
        deckMode: 'pol',
        token: 'secret',
      }),
    ).toThrow()
  })

  it('rejects private process and server fields from MonitorView', () => {
    const base = {
      state: 'STOPPED',
      preferences: { searchMode: 'fast', deckMode: 'pol' },
      readiness: { authenticated: true, captureConfigured: true, sourceAvailable: null },
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
    }
    expect(MonitorViewResultSchema.parse(base)).toEqual(base)
    for (const field of [
      'token',
      'imageBase64',
      'rawResponse',
      'selector',
      'windowHwnd',
    ]) {
      expect(
        MonitorViewResultSchema.safeParse({ ...base, [field]: 'private' }).success,
      ).toBe(false)
    }
  })
})
