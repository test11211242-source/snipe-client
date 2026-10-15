import { vi } from 'vitest'

import type { DetectionPreview } from '../../../shared/contracts/auto-setup'
import type { CrToolsSetupApi } from '../../../shared/contracts/preload'
import type {
  CaptureSourceSnapshot,
  NormalizedRect,
  TriggerProfile,
} from '../../../shared/models/capture'
import type { SetupFrame, SetupSessionView } from '../../../shared/models/setup'
import type { AsyncMock } from './bridge'

/** Setup-session fake that follows main's rules: generations, states, stale rejections. */

export const SESSION_ID = '00000000-0000-4000-8000-0000000000a1'
export const PROFILE_ID = '00000000-0000-4000-8000-000000000001'
export const FRAME = { width: 1000, height: 500 }
export const TRIGGER: NormalizedRect = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
export const NICK: NormalizedRect = { x: 0.3, y: 0.2, width: 0.2, height: 0.1 }
export const EVIDENCE: NormalizedRect = { x: 0.05, y: 0.02, width: 0.3, height: 0.1 }

export function triggerProfile(grade: 'high' | 'medium' = 'high'): TriggerProfile {
  return {
    schemaVersion: 3,
    analyzer: { name: 'cr-tools-trigger-analyzer', version: '2.0.0' },
    innerRect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    structureAlgorithm: 'max-channel-scharr-v1',
    structureHash64: '0123456789abcdef',
    matcherMode: 'edge_orb',
    normalizedTemplateSize: { width: 128, height: 128 },
    structureTemplateBase64: 'dGVzdA==',
    edgeTemplateBase64: 'dGVzdA==',
    orientationTemplateBase64: 'dGVzdA==',
    quality: {
      grade,
      score: grade === 'high' ? 0.96 : 0.71,
      edgePixelCount: 512,
      edgeCoverage: 0.75,
      keypointsCount: 12,
      cropConfidence: 0.9,
      cropAreaRatio: 0.64,
    },
  }
}

export function sessionView(overrides: Partial<SetupSessionView> = {}): SetupSessionView {
  return {
    sessionId: SESSION_ID,
    generation: 1,
    state: 'SELECTING',
    source: { kind: 'display', label: 'Экран 2', displayId: 'display-2' },
    profileId: PROFILE_ID,
    profileName: 'Ноутбук',
    frameSize: FRAME,
    detection: null,
    game: null,
    triggerKind: null,
    triggerOutline: null,
    regionOrigins: null,
    regions: {
      trigger: null,
      nickname: null,
      topLeftEvidence: null,
    },
    triggerProfile: null,
    error: null,
    saveOutcome: null,
    ...overrides,
  }
}

export const GAME_VIEWPORT: NormalizedRect = { x: 0.36, y: 0, width: 0.28, height: 1 }
export const GAME_ASPECT = 0.56
const DEADLINE_MS = 60_000

export const PREVIEW: DetectionPreview = {
  width: 320,
  height: 160,
  mimeType: 'image/jpeg',
  byteLength: 2,
  bytes: new Uint8Array([0xff, 0xd8]),
}

/** A running automatic wait that started `startedAgoMs` ago. */
export function runningDetection(
  startedAgoMs = 0,
): NonNullable<SetupSessionView['detection']> {
  const started = Date.now() - startedAgoMs
  return {
    status: 'running',
    phase: 'waiting_vs',
    startedAt: new Date(started).toISOString(),
    deadlineAt: new Date(started + DEADLINE_MS).toISOString(),
    game: null,
    failure: null,
    frameAvailable: false,
    nameCheck: { status: 'pending', text: null },
  }
}

/** What `startCaptureSetup({ mode: 'auto' })` returns: waiting for the training battle. */
export function detectingView(
  overrides: Partial<SetupSessionView> = {},
): SetupSessionView {
  return sessionView({
    generation: 0,
    state: 'DETECTING',
    frameSize: null,
    detection: runningDetection(),
    ...overrides,
  })
}

/** A waiting session whose attempt ended with `code`. */
export function failedDetectionView(
  code: NonNullable<NonNullable<SetupSessionView['detection']>['failure']>['code'],
  overrides: Partial<SetupSessionView> = {},
): SetupSessionView {
  return detectingView({
    generation: 1,
    detection: { ...runningDetection(60_000), status: 'failed', failure: { code } },
    ...overrides,
  })
}

/** The success main reports: `SELECTING`, three automatic zones and a trigger profile. */
export function detectedView(
  overrides: Partial<SetupSessionView> = {},
): SetupSessionView {
  return sessionView({
    generation: 2,
    detection: {
      ...runningDetection(5_000),
      status: 'succeeded',
      phase: null,
      game: { viewport: GAME_VIEWPORT, aspect: GAME_ASPECT },
      frameAvailable: true,
      nameCheck: { status: 'trainer', text: 'Тренер Чеддер' },
    },
    game: { viewport: GAME_VIEWPORT, aspect: GAME_ASPECT, source: 'auto' },
    regionOrigins: { trigger: 'auto', nickname: 'auto', topLeftEvidence: 'auto' },
    triggerKind: 'vs_edge_orientation',
    triggerOutline: [
      [0.48, 0.42],
      [0.5, 0.41],
      [0.52, 0.42],
      [0.515, 0.5],
      [0.5, 0.51],
      [0.485, 0.5],
    ],
    regions: {
      trigger: { x: 0.47, y: 0.4, width: 0.06, height: 0.12 },
      nickname: { x: 0.38, y: 0.3, width: 0.24, height: 0.08 },
      topLeftEvidence: { x: 0.37, y: 0.02, width: 0.12, height: 0.06 },
    },
    triggerProfile: triggerProfile(),
    ...overrides,
  })
}

export function sourcesFixture(): CaptureSourceSnapshot {
  const revision = 'c'.repeat(32)
  return {
    revision,
    expiresAt: Date.now() + 30_000,
    sources: [
      {
        sourceKey: 'a'.repeat(32),
        revision,
        kind: 'window',
        label: 'BlueStacks App Player',
        detail: 'HD-Player.exe',
        captureSupported: true,
        unavailableReason: null,
        preview: null,
      },
      {
        sourceKey: 'b'.repeat(32),
        revision,
        kind: 'window',
        label: 'Диспетчер задач',
        detail: 'Taskmgr.exe',
        captureSupported: false,
        unavailableReason: 'Окно нельзя захватить',
        preview: null,
      },
      {
        sourceKey: 'd'.repeat(32),
        revision,
        kind: 'display',
        label: 'Экран 2',
        detail: '1920 × 1080',
        captureSupported: true,
        unavailableReason: null,
        preview: null,
      },
    ],
  }
}

export interface SetupFakeOptions {
  /** Session main already has (`null`: none). */
  initial?: SetupSessionView | null
  /** What `commit` leaves behind. */
  committed?: Partial<SetupSessionView>
  grade?: 'high' | 'medium'
  /** The live picture main returns (`null`: none yet). */
  preview?: DetectionPreview | null
  /** `retryDetection` finds the window gone. */
  sourceLost?: boolean
}

export interface SetupFake {
  api: Record<keyof CrToolsSetupApi, AsyncMock>
  /** Current state of the fake main-side session. */
  current: () => SetupSessionView | null
  /** Replace the main-side session without bumping anything (an outside change). */
  replace: (view: SetupSessionView | null) => void
}

const STALE = 'Error invoking remote method: Error: Setup command is stale'

/** Installs nothing: assign `fake.api` over `window.crTools.setup`. */
export function createSetupFake(options: SetupFakeOptions = {}): SetupFake {
  let state: SetupSessionView | null =
    options.initial === undefined ? null : options.initial
  const fence = (payload: {
    sessionId: string
    generation: number
  }): SetupSessionView => {
    if (state === null) throw new Error('No setup is active')
    if (payload.sessionId !== state.sessionId) throw new Error('Setup session is stale')
    if (payload.generation !== state.generation) throw new Error(STALE)
    return state
  }
  const next = (patch: Partial<SetupSessionView>): SetupSessionView => {
    const current = state
    if (current === null) throw new Error('No setup is active')
    state = { ...current, generation: current.generation + 1, ...patch }
    return state
  }
  const frame = (current: SetupSessionView): SetupFrame => ({
    sessionId: current.sessionId,
    generation: current.generation,
    size: current.frameSize ?? FRAME,
    byteLength: 1,
    mimeType: 'image/png',
    bytes: new Uint8Array([1]),
  })

  const api = {
    getSession: vi.fn(() => {
      if (state === null) return Promise.reject(new Error('No setup is active'))
      return Promise.resolve(state)
    }),
    getFrame: vi.fn((payload: { sessionId: string; generation: number }) =>
      Promise.resolve(frame(fence(payload))),
    ),
    setRegion: vi.fn(
      (payload: {
        sessionId: string
        generation: number
        region: keyof SetupSessionView['regions']
        rect: NormalizedRect
      }) => {
        const current = fence(payload)
        if (current.state !== 'SELECTING')
          return Promise.reject(new Error('Regions cannot be changed now'))
        const resets = payload.region === 'trigger'
        return Promise.resolve(
          next({
            regions: { ...current.regions, [payload.region]: payload.rect },
            ...(resets ? { triggerProfile: null } : {}),
            error: null,
          }),
        )
      },
    ),
    analyzeTrigger: vi.fn((payload: { sessionId: string; generation: number }) => {
      fence(payload)
      return Promise.resolve(
        next({ triggerProfile: triggerProfile(options.grade ?? 'high'), error: null }),
      )
    }),
    review: vi.fn((payload: { sessionId: string; generation: number }) => {
      fence(payload)
      return Promise.resolve(next({ state: 'REVIEW', error: null }))
    }),
    commit: vi.fn((payload: { sessionId: string; generation: number }) => {
      fence(payload)
      return Promise.resolve(
        next({
          state: 'COMMITTED',
          saveOutcome: {
            local: 'saved',
            projection: 'synced',
            runtime: 'ready',
            warning: null,
          },
          ...options.committed,
        }),
      )
    }),
    retrySync: vi.fn((payload: { sessionId: string; generation: number }) => {
      fence(payload)
      return Promise.resolve(
        next({
          saveOutcome: {
            local: 'saved',
            projection: 'synced',
            runtime: 'ready',
            warning: null,
          },
        }),
      )
    }),
    cancel: vi.fn((payload: { sessionId: string; generation: number }) => {
      fence(payload)
      return Promise.resolve(next({ state: 'CANCELLED' }))
    }),
    close: vi.fn((payload: { sessionId: string; generation: number }) => {
      const current = fence(payload)
      return Promise.resolve(
        ['COMMITTED', 'CANCELLED', 'FAILED'].includes(current.state)
          ? current
          : next({ state: 'CANCELLED' }),
      )
    }),
    finish: vi.fn(),
    retryDetection: vi.fn((payload: { sessionId: string; generation: number }) => {
      const current = fence(payload)
      if (current.state !== 'DETECTING' || current.detection?.status !== 'failed')
        return Promise.reject(new Error('Настройка изменилась — откройте её ещё раз'))
      if (options.sourceLost)
        return Promise.reject(new Error('Окно игры закрыто или свёрнуто'))
      return Promise.resolve(next({ detection: runningDetection() }))
    }),
    switchToManual: vi.fn((payload: { sessionId: string; generation: number }) => {
      const current = fence(payload)
      if (current.state !== 'DETECTING')
        return Promise.reject(new Error('Настройка изменилась — откройте её ещё раз'))
      return Promise.resolve(
        next({
          state: 'SELECTING',
          frameSize: FRAME,
          game: { viewport: GAME_VIEWPORT, aspect: GAME_ASPECT, source: 'freeze' },
          regionOrigins: {
            trigger: 'manual',
            nickname: 'manual',
            topLeftEvidence: 'manual',
          },
          error: null,
        }),
      )
    }),
    getDetectionPreview: vi.fn((payload: { sessionId: string }) => {
      const current = fence({ ...payload, generation: state?.generation ?? 0 })
      if (current.state !== 'DETECTING' || current.detection?.status !== 'running')
        return Promise.reject(new Error('Настройка изменилась — откройте её ещё раз'))
      return Promise.resolve(options.preview === undefined ? PREVIEW : options.preview)
    }),
  } satisfies Record<keyof CrToolsSetupApi, AsyncMock>

  return {
    api,
    current: () => state,
    replace: (view) => {
      state = view
    },
  }
}
