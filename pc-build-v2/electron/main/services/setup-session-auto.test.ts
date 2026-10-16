import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AnalysisProgress,
  AnalysisResult,
  DetectionPreview,
} from '../../../shared/contracts/auto-setup'
import { ApplicationError } from '../../../shared/errors/application-error'
import { VsOrientationTriggerSchema } from '../../../shared/models/capture'
import type { CaptureConfiguration } from '../../../shared/models/capture'
import type { SetupNameCheck } from '../../../shared/models/setup'
import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { ApiClient } from './api-client'
import type { AuthSession } from './auth-session'
import type { LivePreparedCapture } from './capture-preparation-service'
import type { CapturedFrame, CaptureService } from './capture-service'
import { SetupSessionService } from './setup-session-service'
import type { SetupNameChecker } from './setup-session-service'
import { BinaryEnvelopeStreamDecoder, encodeBinaryEnvelope } from './binary-protocol'
import { CapturePreparationService } from './capture-preparation-service'
import {
  PreparedCaptureProcessService,
  type PreparedCaptureChild,
} from './prepared-capture-process-service'
import type { CaptureSourceRegistry } from './capture-source-registry'

const chrome = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  topEdges: null,
  bottomEdges: null,
  leftEdges: null,
  rightEdges: null,
}
const game = { rect: { x: 100, y: 100, width: 800, height: 1600 }, aspect: 0.5, chrome }
const frame: CapturedFrame = {
  size: { width: 1200, height: 1800 },
  png: Buffer.from('confirmation PNG'),
  game: { ...game, frames: 8 },
}
const badge = { cx: 0.5, cy: 0.43, width: 0.2, height: 0.15 }
const orientation = VsOrientationTriggerSchema.parse({
  kind: 'vs_edge_orientation',
  algorithm: 'vs-orient-1',
  badge,
  normalizedSize: { width: 96, height: 96 },
  cropMargin: 0.08,
  padding: 4,
  maxShift: 3,
  threshold: 0.5,
  angleQ8Base64: Buffer.alloc(96 * 96).toString('base64'),
  weightQ8Base64: Buffer.alloc(96 * 96, 100).toString('base64'),
  templateHash64: '1234567890abcdef',
  maskAreaRatio: 0.5,
})
const profile = {
  schemaVersion: 3 as const,
  analyzer: { name: 'cr-tools-trigger-analyzer' as const, version: '2.0.0' },
  innerRect: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 },
  structureAlgorithm: 'max-channel-scharr-v1' as const,
  structureHash64: '0123456789abcdef',
  matcherMode: 'edge' as const,
  normalizedTemplateSize: { width: 128, height: 128 },
  structureTemplateBase64: 'AAAA',
  edgeTemplateBase64: 'AAAA',
  orientationTemplateBase64: 'AAAA',
  quality: {
    grade: 'medium' as const,
    score: 0.65,
    edgePixelCount: 120,
    edgeCoverage: 0.5,
    keypointsCount: 3,
    cropConfidence: 0.8,
    cropAreaRatio: 0.48,
  },
}
const legacyProfile = {
  templateGrayBase64: 'AAAA',
  thumbnailHash: 'fedcba9876543210',
  featureMode: 'ncc' as const,
  keypointsCount: 3,
  normalizedTemplateSize: { width: 128 as const, height: 128 as const },
  hashThreshold: 5 as const,
  orbDistanceThreshold: 55 as const,
  orbMinGoodMatches: 10 as const,
  nccThreshold: 0.72 as const,
  analyzerVersion: 'trigger-profile-v2' as const,
}
const regions = {
  trigger: { x: 0.3, y: 0.35, width: 0.3, height: 0.2 },
  nickname: { x: 0.1, y: 0.2, width: 0.7, height: 0.1 },
  topLeftEvidence: { x: 0.1, y: 0.05, width: 0.3, height: 0.1 },
}
const shieldOutline: [number, number][] = [
  [0.4, 0.4],
  [0.5, 0.38],
  [0.6, 0.4],
  [0.5, 0.52],
]
const success: AnalysisResult = {
  ok: true,
  frameWidth: frame.size.width,
  frameHeight: frame.size.height,
  game,
  badge,
  regions,
  trigger: orientation,
  outline: shieldOutline,
  confidence: 0.9,
  selfCheck: { minVs: 0.9, maxBefore: 0.2, frames: 3 },
  timings: { onsetMs: 1000, confirmMs: 1200 },
}
const selector = { kind: 'window' as const, windowHwnd: '12345' }
const preference = {
  kind: 'window' as const,
  label: 'Game',
  titleHint: 'Game',
  executableLabel: null,
}
interface DetectionCompletion {
  result: AnalysisResult
  frame: CapturedFrame | null
}

function requiredFixture<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected setup fixture was not populated')
  return value
}

function harness(nameChecker?: SetupNameChecker) {
  let authGeneration = 1
  let alive = true
  const operations: {
    progress: (value: AnalysisProgress) => void
    preview: (value: DetectionPreview) => void
    resolve: (value: DetectionCompletion) => void
    reject: (error: unknown) => void
    signal: AbortSignal | undefined
  }[] = []
  const live = {
    analyze: vi.fn<LivePreparedCapture['analyze']>((progress, preview, signal) => {
      const deferred = Promise.withResolvers<DetectionCompletion>()
      operations.push({
        progress,
        preview,
        signal,
        resolve: deferred.resolve,
        reject: deferred.reject,
      })
      return deferred.promise
    }),
    cancelAnalysis: vi.fn().mockResolvedValue(undefined),
    freeze: vi.fn<LivePreparedCapture['freeze']>(() =>
      alive
        ? Promise.resolve(frame)
        : Promise.reject(
            new ApplicationError('CAPTURE_PREPARATION_STALE', 'Source ended'),
          ),
    ),
    stop: vi.fn(() => {
      alive = false
      return Promise.resolve()
    }),
    isAlive: () => alive,
    getSize: () => frame.size,
  } satisfies LivePreparedCapture
  const capture = {
    capture: vi.fn().mockResolvedValue(frame),
    analyze: vi.fn().mockResolvedValue({
      profile,
      legacyProfile,
      vsOrientation: null,
      vsBadge: null,
      vsOutline: null,
    }),
    crop: vi.fn().mockResolvedValue(Buffer.from('nickname PNG')),
  }
  const repository = {
    list: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  }
  const auth = {
    getView: () => ({ user: { id: '42' } }),
    getContextGeneration: () => authGeneration,
    getAccessToken: vi.fn().mockResolvedValue('token'),
  }
  const api = {
    request: vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, data: { success: true } }),
  }
  const logger = { info: vi.fn(), warn: vi.fn() }
  const service = new SetupSessionService(
    capture as unknown as CaptureService,
    repository as unknown as CaptureConfigurationRepository,
    api as unknown as ApiClient,
    auth as unknown as AuthSession,
    () => new Date('2026-10-13T12:00:00.000Z'),
    nameChecker,
    logger,
  )
  return {
    service,
    live,
    operations,
    capture,
    repository,
    logger,
    changeAuth: () => {
      authGeneration += 1
    },
    loseSource: () => {
      alive = false
    },
  }
}

// Same framed fake-child boundary as the process tests, with real preparation ownership.
class SessionCaptureChild extends EventEmitter implements PreparedCaptureChild {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  commands: string[] = []
  sessionId = ''
  sequence = 0
  killed = false

  constructor() {
    super()
    const decoder = new BinaryEnvelopeStreamDecoder({
      maxMetadataBytes: 64 * 1024,
      maxBinaryBytes: 0,
    })
    this.stdin.on('data', (chunk: Buffer) => {
      for (const envelope of decoder.push(chunk)) {
        const command = envelope.metadata as { type: string; sessionId: string }
        this.sessionId = command.sessionId
        this.commands.push(command.type)
        if (command.type === 'start') {
          queueMicrotask(() =>
            this.send('ready', {
              frameSequence: 1,
              width: frame.size.width,
              height: frame.size.height,
            }),
          )
        }
      }
    })
  }

  send(type: string, payload: unknown): void {
    this.stdout.write(
      encodeBinaryEnvelope({
        protocolVersion: 2,
        sessionId: this.sessionId,
        sequence: ++this.sequence,
        type,
        payload,
      }),
    )
  }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('close', 0, null))
    return true
  }
}

async function joinedHarness() {
  const test = harness()
  const child = new SessionCaptureChild()
  const process = new PreparedCaptureProcessService(
    'python.exe',
    'prepared_capture.py',
    test.logger,
    () => child,
  )
  const preparations = new CapturePreparationService(
    {
      resolve: vi.fn().mockResolvedValue({ selector, preference }),
    } as unknown as CaptureSourceRegistry,
    process,
  )
  const prepared = await preparations.prepare('source', 'revision')
  const { capture } = await preparations.takeLive(prepared.preparationId)
  const view = await test.service.startAuto(selector, preference, capture)
  return { ...test, child, process, preparations, view }
}

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('automatic setup session lifecycle', () => {
  it('returns DETECTING immediately with real dates, and fences preview/progress commands', async () => {
    const test = harness()
    const view = await test.service.startAuto(selector, preference, test.live)
    expect(view).toMatchObject({
      state: 'DETECTING',
      generation: 0,
      detection: {
        status: 'running',
        phase: null,
        startedAt: '2026-10-13T12:00:00.000Z',
        deadlineAt: '2026-10-13T12:01:00.000Z',
        nameCheck: { status: 'pending', text: null },
      },
    })
    expect(test.capture.capture).not.toHaveBeenCalled()
    expect(test.live.freeze).not.toHaveBeenCalled()
    expect(test.service.getDetectionPreview(view.sessionId)).toBeNull()
    const preview: DetectionPreview = {
      width: 320,
      height: 480,
      mimeType: 'image/jpeg',
      byteLength: 3,
      bytes: new Uint8Array([1, 2, 3]),
    }
    requiredFixture(test.operations[0]).preview(preview)
    requiredFixture(test.operations[0]).progress({
      phase: 'waiting_vs',
      elapsedMs: 2000,
      game: null,
      framesAnalyzed: 20,
    })
    expect(test.service.getDetectionPreview(view.sessionId)).toEqual(preview)
    expect(test.service.getSession().detection?.phase).toBe('waiting_vs')
    expect(() => test.service.retryDetection(view.sessionId, view.generation)).toThrow(
      expect.objectContaining({ code: 'SETUP_DETECTION_STATE_INVALID' }),
    )
    test.service.cancel(view.sessionId, view.generation)
    requiredFixture(test.operations[0]).preview(preview)
    await settle()
    expect(test.live.stop).toHaveBeenCalledOnce()
    expect(test.service.getSession().state).toBe('CANCELLED')
  })

  it('retains a rejected candidate and switches manually without taking a new frame', async () => {
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({
      result: { ok: false, code: 'AUTO_LAYOUT_UNEXPECTED', game, regions },
      frame,
    })
    await settle()
    const failed = test.service.getSession()
    expect(failed).toMatchObject({
      state: 'DETECTING',
      generation: started.generation,
      detection: {
        status: 'failed',
        failure: { code: 'AUTO_LAYOUT_UNEXPECTED' },
        frameAvailable: true,
      },
    })
    const manual = await test.service.switchToManual(failed.sessionId, failed.generation)
    expect(manual.state).toBe('SELECTING')
    expect(requiredFixture(manual.regions.nickname).x).toBeCloseTo(
      (100 + 0.1 * 800) / 1200,
    )
    expect(manual.regionOrigins).toEqual({
      trigger: 'auto',
      nickname: 'auto',
      topLeftEvidence: 'auto',
    })
    expect(test.service.getFrame(manual.sessionId, manual.generation).bytes).toEqual(
      new Uint8Array(frame.png),
    )
    expect(test.live.freeze).not.toHaveBeenCalled()
    expect(test.live.cancelAnalysis).toHaveBeenCalledOnce()
    expect(test.live.stop).toHaveBeenCalledOnce()
  })

  it('cancels the running analyzer before freezing, ignoring a late automatic result', async () => {
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    const cancellation = Promise.withResolvers<undefined>()
    test.live.cancelAnalysis.mockReturnValueOnce(cancellation.promise)
    const switched = test.service.switchToManual(started.sessionId, started.generation)
    await settle()
    expect(test.live.freeze).not.toHaveBeenCalled()
    expect(requiredFixture(requiredFixture(test.operations[0]).signal).aborted).toBe(true)
    cancellation.resolve(undefined)
    const manual = await switched
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    expect(manual).toMatchObject({
      state: 'SELECTING',
      game: { source: 'freeze' },
      regions: {
        trigger: null,
        nickname: null,
        topLeftEvidence: null,
      },
    })
    expect(test.service.getSession()).toEqual(manual)
    expect(test.capture.analyze).not.toHaveBeenCalled()
  })

  it('fails manual transition when the frozen frame has no game', async () => {
    const test = harness()
    test.live.freeze.mockResolvedValueOnce({
      ...frame,
      game: { rect: null, reason: 'unstable' },
    })
    const started = await test.service.startAuto(selector, preference, test.live)
    const manual = await test.service.switchToManual(
      started.sessionId,
      started.generation,
    )
    expect(manual).toMatchObject({
      state: 'FAILED',
      error: { code: 'SETUP_GAME_NOT_FOUND' },
    })
    expect(test.repository.save).not.toHaveBeenCalled()
    expect(test.live.stop).toHaveBeenCalledOnce()
  })

  it('retries a failed detection on the same live source and resets all analysis fields', async () => {
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({
      result: { ok: false, code: 'AUTO_VS_TIMEOUT', game, regions },
      frame,
    })
    await settle()
    const retry = test.service.retryDetection(started.sessionId, started.generation)
    expect(retry).toMatchObject({
      state: 'DETECTING',
      generation: 1,
      game: null,
      frameSize: null,
      regionOrigins: null,
      triggerProfile: null,
      detection: {
        status: 'running',
        phase: null,
        failure: null,
        frameAvailable: false,
      },
      regions: { trigger: null, nickname: null, topLeftEvidence: null },
    })
    requiredFixture(test.operations[0]).progress({
      phase: 'verifying',
      elapsedMs: 10,
      game: null,
      framesAnalyzed: 1,
    })
    expect(test.service.getSession().detection?.phase).toBeNull()
    expect(test.live.analyze).toHaveBeenCalledTimes(2)
    test.service.close(retry.sessionId, retry.generation)
    await settle()
  })

  it('refuses retry for a dead source and keeps the original failure/candidate', async () => {
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({
      result: { ok: false, code: 'AUTO_SOURCE_LOST' },
      frame: null,
    })
    await settle()
    test.loseSource()
    expect(() =>
      test.service.retryDetection(started.sessionId, started.generation),
    ).toThrow(expect.objectContaining({ code: 'SETUP_SOURCE_LOST' }))
    expect(test.service.getSession().generation).toBe(0)
    test.service.close(started.sessionId, started.generation)
  })

  it('kills a stalled analyzer at 65 seconds without inventing success', async () => {
    vi.useFakeTimers()
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    await vi.advanceTimersByTimeAsync(65_000)
    expect(test.service.getSession()).toMatchObject({
      state: 'DETECTING',
      detection: {
        status: 'failed',
        failure: { code: 'AUTO_INTERNAL_TIMEOUT' },
      },
    })
    expect(test.live.stop).toHaveBeenCalledOnce()
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    expect(test.service.getSession().state).toBe('DETECTING')
    expect(() =>
      test.service.retryDetection(started.sessionId, started.generation),
    ).toThrow(expect.objectContaining({ code: 'SETUP_CAPTURE_UNAVAILABLE' }))
  })

  it('does not accept detection if ancillary structural/legacy analysis fails', async () => {
    const test = harness()
    test.capture.analyze.mockRejectedValueOnce(
      new ApplicationError('TRIGGER_STRUCTURE_WEAK', 'worker failed'),
    )
    const started = await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    const failed = test.service.getSession()
    expect(failed).toMatchObject({
      state: 'DETECTING',
      triggerProfile: null,
      detection: {
        status: 'failed',
        failure: { code: 'AUTO_INTERNAL_ERROR' },
        frameAvailable: true,
      },
    })
    expect(test.logger.warn).toHaveBeenCalledWith('setup.auto_analysis_failed', {
      code: 'TRIGGER_STRUCTURE_WEAK',
    })
    const manual = await test.service.switchToManual(
      started.sessionId,
      started.generation,
    )
    expect(manual.state).toBe('SELECTING')
    expect(test.live.freeze).not.toHaveBeenCalled()
  })

  it('fences source completion after cancellation and replacement', async () => {
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    test.service.cancel(started.sessionId, started.generation)
    const replacement = await test.service.start(selector, preference, frame)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    expect(test.service.getSession()).toEqual(replacement)
    expect(test.capture.analyze).not.toHaveBeenCalled()
    expect(test.live.stop).toHaveBeenCalledOnce()
  })

  it('auth invalidation stops capture and fences progress and success', async () => {
    const test = harness()
    await test.service.startAuto(selector, preference, test.live)
    test.changeAuth()
    requiredFixture(test.operations[0]).progress({
      phase: 'verifying',
      elapsedMs: 10,
      game: null,
      framesAnalyzed: 1,
    })
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    expect(test.live.stop).toHaveBeenCalledOnce()
    expect(requiredFixture(requiredFixture(test.operations[0]).signal).aborted).toBe(true)
    expect(test.capture.analyze).not.toHaveBeenCalled()
    expect(() => test.service.getSession()).toThrow(
      expect.objectContaining({ code: 'AUTH_CONTEXT_CHANGED' }),
    )
  })

  it('fences auth changes during ancillary analysis', async () => {
    const test = harness()
    const ancillary = Promise.withResolvers<{
      profile: typeof profile
      legacyProfile: typeof legacyProfile
      vsOrientation: null
      vsBadge: null
      vsOutline: null
    }>()
    test.capture.analyze.mockReturnValueOnce(ancillary.promise)
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    test.changeAuth()
    ancillary.resolve({
      profile,
      legacyProfile,
      vsOrientation: null,
      vsBadge: null,
      vsOutline: null,
    })
    await settle()
    expect(test.live.stop).toHaveBeenCalledOnce()
    expect(test.repository.save).not.toHaveBeenCalled()
  })

  it('uses authoritative orientation, preserves unchanged auto final-zone provenance on finish', async () => {
    const test = harness()
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    const selected = test.service.getSession()
    expect(selected).toMatchObject({
      state: 'SELECTING',
      triggerKind: 'vs_edge_orientation',
      detection: { status: 'succeeded' },
      regionOrigins: { trigger: 'auto', nickname: 'auto', topLeftEvidence: 'auto' },
    })
    // The success screen draws the compared silhouette: game fractions → frame fractions.
    expect(selected.triggerOutline).toEqual(
      shieldOutline.map(([x, y]) => [
        game.rect.x / frame.size.width + x * (game.rect.width / frame.size.width),
        game.rect.y / frame.size.height + y * (game.rect.height / frame.size.height),
      ]),
    )
    expect(test.live.stop).toHaveBeenCalledOnce()
    expect(test.capture.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ png: frame.png }),
      selected.regions.trigger,
      expect.any(AbortSignal),
      game.rect,
    )
    const committed = await test.service.finish(
      selected.sessionId,
      selected.generation,
      'topLeftEvidence',
      requiredFixture(selected.regions.topLeftEvidence),
    )
    expect(committed.state).toBe('COMMITTED')
    const saved = requiredFixture(
      test.repository.save.mock.calls[0],
    )[0] as CaptureConfiguration
    expect(saved.calibration.coordinateSpace).toBe('game_relative')
    if (saved.calibration.coordinateSpace !== 'game_relative')
      throw new Error('wrong calibration')
    expect(requiredFixture(saved.calibration.layouts[0]).trigger).toEqual(orientation)
    expect(requiredFixture(saved.calibration.layouts[0]).provenance).toMatchObject({
      trigger: { origin: 'auto', confidence: 0.9, analyzerVersion: 'vs-orient-1' },
      nickname: { origin: 'auto', confidence: 0.9, analyzerVersion: 'm9-geom-1' },
      topLeftEvidence: { origin: 'auto', confidence: 0.9, analyzerVersion: 'm9-geom-1' },
      viewport: { origin: 'auto', confidence: 0.9, analyzerVersion: 'm9-geom-1' },
    })
    expect(test.capture.analyze).toHaveBeenCalledOnce()
    expect(test.live.stop).toHaveBeenCalledOnce()
  })

  it('marks only a manually edited zone manual and resets analysis only for trigger edits', async () => {
    const test = harness()
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    let view = test.service.getSession()
    view = test.service.setRegion(view.sessionId, view.generation, 'nickname', {
      ...requiredFixture(view.regions.nickname),
      width: 0.3,
    })
    expect(view.regionOrigins).toEqual({
      trigger: 'auto',
      nickname: 'manual',
      topLeftEvidence: 'auto',
    })
    expect(view.triggerKind).toBe('vs_edge_orientation')
    const reviewed = test.service.review(view.sessionId, view.generation)
    await test.service.commit(reviewed.sessionId, reviewed.generation)
    const saved = requiredFixture(
      test.repository.save.mock.calls[0],
    )[0] as CaptureConfiguration
    if (saved.calibration.coordinateSpace !== 'game_relative')
      throw new Error('wrong calibration')
    expect(requiredFixture(saved.calibration.layouts[0]).provenance.nickname).toEqual({
      origin: 'manual',
      confidence: null,
      analyzerVersion: null,
    })
  })

  it('name check is one cropped request, nonblocking save aborts its pending diagnostics', async () => {
    const result = Promise.withResolvers<SetupNameCheck>()
    const checker = {
      checkSetupName: vi.fn<SetupNameChecker['checkSetupName']>(() => result.promise),
    }
    const test = harness(checker)
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    let view = test.service.getSession()
    expect(view.detection?.nameCheck.status).toBe('pending')
    expect(test.capture.crop).toHaveBeenCalledWith(
      expect.objectContaining({ png: frame.png }),
      view.regions.nickname,
      expect.any(AbortSignal),
    )
    expect(checker.checkSetupName).toHaveBeenCalledOnce()
    expect(requiredFixture(checker.checkSetupName.mock.calls[0])[0]).toEqual(
      Buffer.from('nickname PNG'),
    )
    view = test.service.review(view.sessionId, view.generation)
    view = await test.service.commit(view.sessionId, view.generation)
    expect(view.state).toBe('COMMITTED')
    expect(requiredFixture(checker.checkSetupName.mock.calls[0])[1]?.aborted).toBe(true)
    result.resolve({ status: 'trainer', text: 'Trainer Cheddar' })
    await settle()
    expect(test.service.getSession()).toMatchObject({
      generation: view.generation,
      detection: { nameCheck: { status: 'pending', text: null } },
    })
  })

  it('logs a completed name check status without image or recognized text', async () => {
    const test = harness({
      checkSetupName: vi.fn().mockResolvedValue({
        status: 'trainer',
        text: 'Private nickname',
        httpStatus: 200,
      }),
    })
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    expect(test.logger.info).toHaveBeenCalledWith('setup.name_check', {
      status: 'trainer',
      httpStatus: 200,
    })
    expect(JSON.stringify(test.logger.info.mock.calls)).not.toContain('Private nickname')
    expect(test.service.getSession().detection?.nameCheck).toEqual({
      status: 'trainer',
      text: 'Private nickname',
    })
  })

  it.each(['unavailable', 'not_trainer'] as const)(
    'does not block successful detection or save when name status is %s',
    async (status) => {
      const checker = {
        checkSetupName: vi.fn().mockResolvedValue({ status, text: null }),
      }
      const test = harness(checker)
      await test.service.startAuto(selector, preference, test.live)
      requiredFixture(test.operations[0]).resolve({ result: success, frame })
      await settle()
      const view = test.service.getSession()
      expect(view).toMatchObject({
        state: 'SELECTING',
        detection: { status: 'succeeded', nameCheck: { status } },
      })
      const committed = await test.service.finish(
        view.sessionId,
        view.generation,
        'topLeftEvidence',
        requiredFixture(view.regions.topLeftEvidence),
      )
      expect(committed.state).toBe('COMMITTED')
    },
  )

  it('maps failed crop/check to unavailable and ignores a late name result after close', async () => {
    const deferred = Promise.withResolvers<SetupNameCheck>()
    const checker = {
      checkSetupName: vi.fn<SetupNameChecker['checkSetupName']>(() => deferred.promise),
    }
    const test = harness(checker)
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    const view = test.service.getSession()
    const closed = test.service.close(view.sessionId, view.generation)
    deferred.resolve({ status: 'trainer', text: 'Cheddar' })
    await settle()
    expect(test.service.getSession()).toEqual(closed)

    const unavailable = harness({
      checkSetupName: vi
        .fn()
        .mockRejectedValue(new ApplicationError('NETWORK_UNAVAILABLE', 'offline')),
    })
    await unavailable.service.startAuto(selector, preference, unavailable.live)
    requiredFixture(unavailable.operations[0]).resolve({ result: success, frame })
    await settle()
    const succeeded = unavailable.service.getSession()
    expect(succeeded.detection?.nameCheck).toEqual({ status: 'unavailable', text: null })
    unavailable.service.close(succeeded.sessionId, succeeded.generation)
  })

  it('editing the automatic trigger invalidates profiles and changes only its origin', async () => {
    const test = harness()
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    const selected = test.service.getSession()
    const edited = test.service.setRegion(
      selected.sessionId,
      selected.generation,
      'trigger',
      {
        ...requiredFixture(selected.regions.trigger),
        width: requiredFixture(selected.regions.trigger).width - 0.01,
      },
    )
    expect(edited).toMatchObject({
      triggerKind: null,
      triggerProfile: null,
      regionOrigins: { trigger: 'manual', nickname: 'auto', topLeftEvidence: 'auto' },
    })
    expect(() => test.service.review(edited.sessionId, edited.generation)).toThrow(
      expect.objectContaining({ code: 'SETUP_INCOMPLETE' }),
    )
    test.service.close(edited.sessionId, edited.generation)
  })

  it('crop failure skips the server request but does not invalidate detection', async () => {
    const checker = { checkSetupName: vi.fn<SetupNameChecker['checkSetupName']>() }
    const test = harness(checker)
    test.capture.crop.mockRejectedValueOnce(new Error('decode failed'))
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    const selected = test.service.getSession()
    expect(selected).toMatchObject({
      state: 'SELECTING',
      detection: {
        status: 'succeeded',
        nameCheck: { status: 'unavailable', text: null },
      },
    })
    expect(checker.checkSetupName).not.toHaveBeenCalled()
    test.service.close(selected.sessionId, selected.generation)
  })

  it('does not publish late name diagnostics into a different auth context', async () => {
    const result = Promise.withResolvers<SetupNameCheck>()
    const checker = {
      checkSetupName: vi.fn<SetupNameChecker['checkSetupName']>(() => result.promise),
    }
    const test = harness(checker)
    await test.service.startAuto(selector, preference, test.live)
    requiredFixture(test.operations[0]).resolve({ result: success, frame })
    await settle()
    test.changeAuth()
    result.resolve({ status: 'trainer', text: 'Cheddar' })
    await settle()
    expect(test.live.stop).toHaveBeenCalledOnce()
    expect(() => test.service.getSession()).toThrow(
      expect.objectContaining({ code: 'AUTH_CONTEXT_CHANGED' }),
    )
  })

  it('maps a failed freeze after actual source loss to the source-lost manual screen', async () => {
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    test.loseSource()
    requiredFixture(test.operations[0]).resolve({
      result: { ok: false, code: 'AUTO_SOURCE_LOST' },
      frame: null,
    })
    await settle()
    const manual = await test.service.switchToManual(
      started.sessionId,
      started.generation,
    )
    expect(test.live.freeze).toHaveBeenCalledOnce()
    expect(manual).toMatchObject({
      state: 'FAILED',
      error: { code: 'SETUP_SOURCE_LOST' },
    })
  })

  it('handles manual transition after internal timeout as a source loss, not an invalid command', async () => {
    vi.useFakeTimers()
    const test = harness()
    const started = await test.service.startAuto(selector, preference, test.live)
    await vi.advanceTimersByTimeAsync(65_000)
    const manual = await test.service.switchToManual(
      started.sessionId,
      started.generation,
    )
    expect(manual).toMatchObject({
      state: 'FAILED',
      error: { code: 'SETUP_SOURCE_LOST' },
    })
  })

  it('joins real preparation/process ownership for source loss then manual fallback', async () => {
    const test = await joinedHarness()
    test.child.send('analysis_result', { ok: false, code: 'AUTO_SOURCE_LOST' })
    await settle()
    expect(test.child.killed).toBe(true)
    expect(test.service.getSession().detection?.failure?.code).toBe('AUTO_SOURCE_LOST')
    const manual = await test.service.switchToManual(
      test.view.sessionId,
      test.view.generation,
    )
    expect(manual).toMatchObject({
      state: 'FAILED',
      error: { code: 'SETUP_SOURCE_LOST' },
    })
    expect(test.child.commands).not.toContain('freeze')
  })

  it('joins a fatal arriving while failed and refuses retry without claiming window loss', async () => {
    const test = await joinedHarness()
    test.child.send('analysis_result', { ok: false, code: 'AUTO_VS_TIMEOUT' })
    await settle()
    test.child.send('fatal', {
      code: 'PREPARED_CAPTURE_FAILED',
      message: 'worker failed',
    })
    await settle()
    expect(test.child.killed).toBe(true)
    expect(() =>
      test.service.retryDetection(test.view.sessionId, test.view.generation),
    ).toThrow(expect.objectContaining({ code: 'SETUP_CAPTURE_UNAVAILABLE' }))
    test.service.close(test.view.sessionId, test.view.generation)
  })

  it('joins cancellation with in-flight analysis events and stops without protocol failure', async () => {
    const test = await joinedHarness()
    test.service.cancel(test.view.sessionId, test.view.generation)
    test.child.send('analysis_progress', {
      phase: 'waiting_vs',
      elapsedMs: 10,
      framesAnalyzed: 1,
      game: null,
    })
    test.child.send('analysis_result', { ok: false, code: 'AUTO_VS_TIMEOUT' })
    test.child.send('stopped', {})
    test.child.emit('close', 0, null)
    await settle()
    expect(test.child.commands).toContain('stop')
    expect(test.child.killed).toBe(false)
    expect(test.logger.warn).not.toHaveBeenCalled()
    expect(test.service.getSession().state).toBe('CANCELLED')
  })
})
