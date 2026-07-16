import { describe, expect, it } from 'vitest'

import { MonitorPreferencesPayloadSchema, MonitorViewResultSchema } from './monitor-ipc'
import { MonitorProcessEventSchema, MonitorStartPayloadSchema } from './monitor-protocol'

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

  it('requires a finite bounded capture delay in the monitor process payload', () => {
    const base = {
      selector: { kind: 'window' as const, windowHwnd: '123' },
      configuredFrameSize: { width: 1920, height: 1080 },
      regions: {
        trigger: { x: 0, y: 0, width: 0.2, height: 0.2 },
        normal: { x: 0, y: 0, width: 0.5, height: 0.5 },
        precise: { x: 0, y: 0, width: 1, height: 1 },
      },
      triggerProfile: {
        schemaVersion: 2,
        analyzer: { name: 'cr-tools-trigger-analyzer', version: '1.0.0' },
        hashAlgorithm: 'ahash64-bitwise-v1',
        ahash64: '0123456789abcdef',
        innerRect: { x: 0, y: 0, width: 1, height: 1 },
        featureMode: 'ncc',
        keypointsCount: 0,
        normalizedTemplateSize: { width: 128, height: 128 },
        templateGrayBase64: 'AAAA',
        hashMaxDistance: 18,
        orbDistanceThreshold: 55,
        orbMinGoodMatches: 10,
        nccMinScore: 0.72,
      },
      searchMode: 'precise',
      captureDelaySeconds: 2.2,
      limits: {
        fps: 10,
        maxImageBytes: 10 * 1024 * 1024,
        maxImagePixels: 20_000_000,
        maxImageWidth: 8192,
        maxImageHeight: 8192,
        confirmationsNeeded: 2,
        confirmationDecay: 0.5,
        cooldownSeconds: 15,
      },
      prediction: null,
    }
    expect(MonitorStartPayloadSchema.parse(base).captureDelaySeconds).toBe(2.2)
    expect(
      MonitorStartPayloadSchema.safeParse({ ...base, captureDelaySeconds: -0.1 }).success,
    ).toBe(false)
    expect(
      MonitorStartPayloadSchema.safeParse({ ...base, captureDelaySeconds: 5.1 }).success,
    ).toBe(false)
  })

  it('accepts the protocol v2 immediate triggered event only', () => {
    const event = {
      protocolVersion: 2,
      sessionId: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
      sequence: 2,
      type: 'triggered',
      payload: { timestamp: '2026-07-12T12:00:00.000Z' },
    }
    expect(MonitorProcessEventSchema.parse(event)).toEqual(event)
    expect(
      MonitorProcessEventSchema.safeParse({ ...event, protocolVersion: 1 }).success,
    ).toBe(false)
  })
})
