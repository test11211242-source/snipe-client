import { describe, expect, it } from 'vitest'

import { MonitorPreferencesPayloadSchema, MonitorViewResultSchema } from './monitor-ipc'
import { MonitorProcessEventSchema, MonitorStartPayloadSchema } from './monitor-protocol'
import { monitorGamePrimaryFixture } from '../../tests/monitor-fixtures'

describe('monitor renderer contracts', () => {
  it('accepts only deck mode, rejecting obsolete search policy preferences', () => {
    expect(MonitorPreferencesPayloadSchema.parse({ deckMode: 'pol' })).toEqual({
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
      seq: 1,
      state: 'STOPPED',
      preferences: { deckMode: 'pol' },
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
      runIntent: false,
      search: null,
      session: null,
      summary: null,
      historyError: null,
      geometry: null,
      sourceMinimized: false,
      recovery: null,
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

  it('requires immediate nickname capture with both semantic regions', () => {
    const base = {
      selector: { kind: 'window' as const, windowHwnd: '123' },
      primary: {
        kind: 'full_frame',
        configuredFrameSize: { width: 1920, height: 1080 },
        regions: {
          trigger: { x: 0, y: 0, width: 0.2, height: 0.2 },
          nicknameRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
          topLeftEvidenceRegion: { x: 0, y: 0, width: 1, height: 1 },
        },
        triggerProfile: {
          schemaVersion: 3,
          analyzer: { name: 'cr-tools-trigger-analyzer', version: '2.0.0' },
          innerRect: { x: 0, y: 0, width: 1, height: 1 },
          structureAlgorithm: 'max-channel-scharr-v1',
          structureHash64: '0123456789abcdef',
          matcherMode: 'edge',
          normalizedTemplateSize: { width: 128, height: 128 },
          structureTemplateBase64: 'AAAA',
          edgeTemplateBase64: 'AAAA',
          orientationTemplateBase64: 'AAAA',
          quality: {
            grade: 'medium',
            score: 0.65,
            edgePixelCount: 120,
            edgeCoverage: 0.5,
            keypointsCount: 0,
            cropConfidence: 0,
            cropAreaRatio: 1,
          },
        },
      },
      capturePolicy: 'immediate_nickname',
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
    expect(MonitorStartPayloadSchema.parse(base).capturePolicy).toBe('immediate_nickname')
    const gamePrimary = monitorGamePrimaryFixture()
    const layout = gamePrimary.layouts[0]
    if (layout === undefined) throw new Error('Missing game layout fixture')
    expect(
      MonitorStartPayloadSchema.safeParse({
        ...base,
        primary: {
          ...gamePrimary,
          layouts: [
            {
              ...layout,
              trigger: { kind: 'structural', profile: base.primary.triggerProfile },
              badge: null,
              zonesOrigin: { nickname: 'manual', topLeftEvidence: 'manual' },
            },
          ],
        },
      }).success,
    ).toBe(true)
    for (const extra of [
      { searchMode: 'precise' },
      { captureDelaySeconds: 2.2 },
      { capturePolicy: 'delayed_evidence' },
    ]) {
      expect(MonitorStartPayloadSchema.safeParse({ ...base, ...extra }).success).toBe(
        false,
      )
    }
  })

  it('accepts only protocol v4 triggered events with correlation identity', () => {
    const event = {
      protocolVersion: 4,
      sessionId: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
      sequence: 2,
      type: 'triggered',
      payload: {
        timestamp: '2026-07-12T12:00:00.000Z',
        triggerId: '19d970c1-fc4f-4bea-a767-8f108d3b8739',
      },
    }
    expect(MonitorProcessEventSchema.parse(event)).toEqual(event)
    expect(
      MonitorProcessEventSchema.safeParse({ ...event, protocolVersion: 1 }).success,
    ).toBe(false)
  })
})
