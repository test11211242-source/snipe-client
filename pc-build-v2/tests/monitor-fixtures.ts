import { MonitorViewSchema, type MonitorView } from '../shared/models/monitor'
import type {
  GameLayoutWire,
  MonitorStartPayload,
} from '../shared/contracts/monitor-protocol'

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

export function monitorGamePrimaryFixture(): Extract<
  MonitorStartPayload['primary'],
  { kind: 'game_relative' }
> {
  return {
    kind: 'game_relative',
    profileCalibrationId: '00000000-0000-4000-8000-000000000010',
    layouts: [
      {
        layoutId: '00000000-0000-4000-8000-000000000011',
        layoutSource: 'setup',
        calibratedAt: '2026-10-13T00:00:00.000Z',
        gameAspect: 0.5625,
        windowChrome: {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          topEdges: null,
          bottomEdges: null,
          leftEdges: null,
          rightEdges: null,
        },
        regions: {
          trigger: { x: 0.3, y: 0.4, width: 0.4, height: 0.1 },
          nicknameRegion: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
          topLeftEvidenceRegion: { x: 0, y: 0, width: 0.2, height: 0.2 },
        },
        trigger: {
          kind: 'vs_edge_orientation',
          algorithm: 'vs-orient-1',
          badge: { cx: 0.5, cy: 0.45, width: 0.25, height: 0.08 },
          normalizedSize: { width: 96, height: 64 },
          cropMargin: 0.08,
          padding: 4,
          maxShift: 3,
          threshold: 0.5,
          angleQ8Base64: Buffer.alloc(96 * 64).toString('base64'),
          weightQ8Base64: Buffer.alloc(96 * 64, 255).toString('base64'),
          templateHash64: '0123456789abcdef',
          maskAreaRatio: 0.4,
        },
        badge: { cx: 0.5, cy: 0.45, width: 0.25, height: 0.08 },
        zonesOrigin: { nickname: 'auto', topLeftEvidence: 'auto' },
      },
    ],
    learning: { enabled: true, maxLayouts: 4 },
  }
}

export function monitorLearnedLayoutFixture(): GameLayoutWire {
  const layout = monitorGamePrimaryFixture().layouts[0]
  if (layout === undefined) throw new Error('Missing game layout fixture')
  return {
    layoutId: '00000000-0000-4000-8000-000000000012',
    layoutSource: 'learned',
    calibratedAt: '2026-10-13T00:00:01.000Z',
    gameAspect: 0.75,
    referenceFrameSize: { width: 1200, height: 1600 },
    referenceGameRect: { x: 0, y: 0, width: 1200, height: 1600 },
    windowChrome: layout.windowChrome,
    expectedLayout: 'cr_battle_vs',
    triggerRegion: layout.regions.trigger,
    nicknameRegion: layout.regions.nicknameRegion,
    topLeftEvidenceRegion: layout.regions.topLeftEvidenceRegion,
    trigger: layout.trigger,
    confidence: 0.9,
  }
}
