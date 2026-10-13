import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  AutoSetupCodeSchema,
  type AutoSetupCode,
  type AnalysisProgress,
  type AnalysisResult,
  type DetectionPreview,
} from '../../../shared/contracts/auto-setup'
import { ApplicationError } from '../../../shared/errors/application-error'
import {
  CaptureConfigurationSchema,
  CaptureProfileIdSchema,
  CaptureProfileNameSchema,
  MAX_CAPTURE_PROFILES,
  CaptureStatusSchema,
  NormalizedRectSchema,
  NormalizedRegionsSchema,
  GameRelativeCalibrationSchema,
  type GameLayout,
  type PixelRectSchema,
  type VsOrientationTriggerSchema,
  type PixelSize,
  type CaptureConfiguration,
  type CapturePreference,
  type CaptureStatus,
  type NormalizedRect,
  type RegionKind,
  type TriggerProfile,
} from '../../../shared/models/capture'
import {
  LegacyOcrRegionsSchema,
  SetupFrameSchema,
  SetupSessionViewSchema,
  type LegacyOcrRegions,
  type SetupFrame,
  type SetupSessionView,
  type SetupRuntimeOutcome,
  type SetupNameCheck,
} from '../../../shared/models/setup'
import type { SetupCaptureSelector } from '../domain/capture-source'
import {
  captureConfigurationFingerprint,
  type CaptureConfigurationRepository,
} from '../infrastructure/capture-configuration-repository'
import type { ApiClient } from './api-client'
import type { AuthSession } from './auth-session'
import type { AuthenticatedApiClient } from './api-client'
import type { CaptureTargetResolver } from './capture-target-resolver'
import {
  predictionResultFingerprint,
  type PredictionResultConfigurationRepository,
} from '../infrastructure/prediction-result-configuration-repository'
import {
  PredictionResultConfigurationSchema,
  type PredictionResultConfiguration,
} from '../../../shared/models/prediction-result'
import {
  canonicalizeNormalizedRect,
  normalizedToPixelRect,
  type CapturedFrame,
  type CaptureService,
  type LegacyTriggerAnalysis,
} from './capture-service'
import type { LivePreparedCapture } from './capture-preparation-service'

export interface SetupNameChecker {
  checkSetupName(png: Buffer, signal?: AbortSignal): Promise<SetupNameCheck>
}

type PixelRect = z.infer<typeof PixelRectSchema>
type VsOrientationTrigger = z.infer<typeof VsOrientationTriggerSchema>

interface InternalSession {
  view: SetupSessionView
  selector: SetupCaptureSelector
  frame: CapturedFrame | null
  controller: AbortController
  commitLocked: boolean
  legacyTriggerProfile: LegacyTriggerAnalysis | null
  vsOrientation: VsOrientationTrigger | null
  profileTarget: SetupCaptureProfileTarget | null
  authGeneration: number
  live?: LivePreparedCapture
  detectionController?: AbortController
  detectionOperation?: Promise<void>
  detectionPreview?: DetectionPreview
  autoConfidence?: number
  pendingSync?: {
    requests: { path: `/api/${string}`; body: unknown }[]
    captureFingerprint: string
    resultFingerprint?: string
  }
}

export interface SetupCaptureProfileTarget {
  userId: string
  profileId: string
  profileName: string
  expectedRevision: number
}

const SaveResponseSchema = z.object({ success: z.literal(true) }).loose()

function publicFailure(error: unknown): { code: string; message: string } {
  return error instanceof ApplicationError
    ? error.toPublicError()
    : { code: 'SETUP_FAILED', message: 'Capture setup could not be completed' }
}

export function buildLegacyProjection(
  frame: CapturedFrame,
  regionsInput: unknown,
  profile: TriggerProfile,
  legacyProfile: LegacyTriggerAnalysis,
  source: CapturePreference,
  timestamp: string,
): LegacyOcrRegions {
  const regions = NormalizedRegionsSchema.parse(regionsInput)
  const trigger = normalizedToPixelRect(regions.trigger, frame.size)
  const nickname = normalizedToPixelRect(regions.nickname, frame.size)
  const topLeftEvidence = normalizedToPixelRect(regions.topLeftEvidence, frame.size)
  return LegacyOcrRegionsSchema.parse({
    schema_version: 2,
    capture_reference: {
      target_type: source.kind === 'window' ? 'window' : 'screen',
      target_id: source.kind === 'window' ? 'window-preference' : source.displayId,
      target_name: source.label,
      source_frame_size: frame.size,
      selected_target: {
        targetType: source.kind === 'window' ? 'window' : 'screen',
        name: source.label,
        executableName: source.kind === 'window' ? source.executableLabel : null,
      },
      created_at: timestamp,
    },
    trigger_area: {
      ...trigger,
      ratio: regions.trigger,
      trigger_profile: buildLegacyTriggerProfile(regions.trigger, profile, legacyProfile),
    },
    normal_data_area: { ...nickname, ratio: regions.nickname },
    precise_data_area: { ...topLeftEvidence, ratio: regions.topLeftEvidence },
    screen_resolution: frame.size,
    updated_at: timestamp,
  })
}

function frameToGameRect(
  rect: NormalizedRect,
  size: PixelSize,
  game: PixelRect,
): NormalizedRect {
  const pixels = normalizedToPixelRect(rect, size)
  const relative = NormalizedRectSchema.safeParse({
    x: (pixels.x - game.x) / game.width,
    y: (pixels.y - game.y) / game.height,
    width: pixels.width / game.width,
    height: pixels.height / game.height,
  })
  if (!relative.success) {
    throw new ApplicationError(
      'SETUP_REGION_INVALID',
      'Select the region inside the game rectangle',
    )
  }
  return relative.data
}

function gameToFrameRect(rect: NormalizedRect, layout: GameLayout): NormalizedRect {
  const game = layout.referenceGameRect
  const size = layout.referenceFrameSize
  return NormalizedRectSchema.parse({
    x: (game.x + Math.round(rect.x * game.width)) / size.width,
    y: (game.y + Math.round(rect.y * game.height)) / size.height,
    width: Math.round(rect.width * game.width) / size.width,
    height: Math.round(rect.height * game.height) / size.height,
  })
}

function buildLegacyTriggerProfile(
  outerRatio: NormalizedRect,
  profile: TriggerProfile,
  legacy: LegacyTriggerAnalysis,
) {
  return {
    schema_version: 2 as const,
    outer_ratio: outerRatio,
    inner_ratio: profile.innerRect,
    template_gray_base64: legacy.templateGrayBase64,
    thumbnail_hash: legacy.thumbnailHash,
    hash_algorithm: 'ahash64-hex-char-v1' as const,
    feature_mode: legacy.featureMode,
    keypoints_count: legacy.keypointsCount,
    normalized_template_size: legacy.normalizedTemplateSize,
    hash_threshold: legacy.hashThreshold,
    orb_distance_threshold: legacy.orbDistanceThreshold,
    orb_min_good_matches: legacy.orbMinGoodMatches,
    ncc_threshold: legacy.nccThreshold,
    analyzer_version: legacy.analyzerVersion,
  }
}

export class SetupSessionService {
  #session: InternalSession | null = null
  #startOperation: Promise<void> = Promise.resolve()
  #assertCaptureCommitAllowed: () => void = () => undefined
  #captureCommitted: (activeChanged: boolean) => Promise<SetupRuntimeOutcome> = () =>
    Promise.resolve('not_requested')
  #runCaptureCommit: (
    operation: () => Promise<SetupSessionView>,
  ) => Promise<SetupSessionView> = (operation) => operation()

  constructor(
    private readonly capture: CaptureService,
    private readonly repository: CaptureConfigurationRepository,
    private readonly api: ApiClient,
    private readonly auth: AuthSession,
    private readonly now: () => Date = () => new Date(),
    private readonly resultRepository?: PredictionResultConfigurationRepository,
    private readonly authenticatedApi?: AuthenticatedApiClient,
    private readonly targetResolver?: CaptureTargetResolver,
    private readonly nameChecker?: SetupNameChecker,
  ) {}

  configureCaptureProfileLifecycle(
    assertCommitAllowed: () => void,
    captureCommitted: (activeChanged: boolean) => Promise<SetupRuntimeOutcome>,
    runCaptureCommit: (
      operation: () => Promise<SetupSessionView>,
    ) => Promise<SetupSessionView>,
  ): void {
    this.#assertCaptureCommitAllowed = assertCommitAllowed
    this.#captureCommitted = captureCommitted
    this.#runCaptureCommit = runCaptureCommit
  }

  async start(
    selector: SetupCaptureSelector,
    preference: CapturePreference,
    kind: SetupSessionView['kind'] = 'capture',
    preparedFrame?: CapturedFrame,
    requestedProfile?: Omit<SetupCaptureProfileTarget, 'userId'>,
  ): Promise<SetupSessionView> {
    return this.serializedStart(() =>
      this.performStart(selector, preference, kind, preparedFrame, requestedProfile),
    )
  }

  async startAuto(
    selector: SetupCaptureSelector,
    preference: CapturePreference,
    live: LivePreparedCapture,
    requestedProfile?: Omit<SetupCaptureProfileTarget, 'userId'>,
  ): Promise<SetupSessionView> {
    try {
      return await this.serializedStart(async () => {
        if (
          this.#session !== null &&
          !['COMMITTED', 'CANCELLED', 'FAILED'].includes(this.#session.view.state)
        ) {
          throw new ApplicationError('SETUP_ALREADY_ACTIVE', 'Настройка уже открыта')
        }
        const authGeneration = this.auth.getContextGeneration()
        const userId = this.auth.getView().user?.id ?? null
        const profileTarget = await this.resolveProfileTarget(userId, requestedProfile)
        if (
          this.auth.getContextGeneration() !== authGeneration ||
          this.auth.getView().user?.id !== userId
        ) {
          throw new ApplicationError('AUTH_CONTEXT_CHANGED', 'Войдите ещё раз')
        }
        if (this.#session !== null) await this.stopLive(this.#session)
        if (
          this.auth.getContextGeneration() !== authGeneration ||
          this.auth.getView().user?.id !== userId
        ) {
          throw new ApplicationError('AUTH_CONTEXT_CHANGED', 'Войдите ещё раз')
        }
        const session: InternalSession = {
          selector,
          live,
          frame: null,
          controller: new AbortController(),
          commitLocked: false,
          legacyTriggerProfile: null,
          vsOrientation: null,
          profileTarget,
          authGeneration,
          view: SetupSessionViewSchema.parse({
            kind: 'capture',
            sessionId: randomUUID(),
            generation: 0,
            state: 'DETECTING',
            source: preference,
            profileId: profileTarget.profileId,
            profileName: profileTarget.profileName,
            frameSize: null,
            game: null,
            regionOrigins: null,
            triggerKind: null,
            regions: {
              trigger: null,
              nickname: null,
              topLeftEvidence: null,
              resultTrigger: null,
              resultData: null,
            },
            triggerProfile: null,
            error: null,
          }),
        }
        this.#session = session
        this.launchDetection(session)
        return session.view
      })
    } catch (error) {
      await live.stop()
      throw error
    }
  }

  retryDetection(sessionId: string, generation: number): SetupSessionView {
    const session = this.assertCommand(sessionId, generation)
    if (
      session.view.state !== 'DETECTING' ||
      session.view.detection?.status !== 'failed'
    ) {
      throw this.detectionStateInvalid()
    }
    if (!session.live?.isAlive()) {
      throw new ApplicationError('SETUP_SOURCE_LOST', 'Окно игры закрыто или свёрнуто')
    }
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      generation: generation + 1,
    })
    this.launchDetection(session)
    return session.view
  }

  getDetectionPreview(sessionId: string): DetectionPreview | null {
    const session = this.#session
    if (session?.view.sessionId !== sessionId) {
      throw new ApplicationError('SETUP_SESSION_STALE', 'Настройка изменилась')
    }
    this.assertCommand(sessionId, session.view.generation)
    if (
      session.view.state !== 'DETECTING' ||
      session.view.detection?.status !== 'running'
    ) {
      throw this.detectionStateInvalid()
    }
    return session.detectionPreview ?? null
  }

  async switchToManual(sessionId: string, generation: number): Promise<SetupSessionView> {
    const session = this.assertCommand(sessionId, generation)
    if (session.view.state !== 'DETECTING') {
      throw this.detectionStateInvalid()
    }
    // Fence callbacks before waiting for the analyzer to relinquish the live frame.
    session.detectionController?.abort()
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'CAPTURING',
      generation: generation + 1,
    })
    const operationGeneration = session.view.generation
    try {
      await session.live?.cancelAnalysis()
      await session.detectionOperation
      if (!this.currentDetectionOperation(session, operationGeneration, 'CAPTURING')) {
        return session.view
      }
      const retainedFrame = session.frame
      const retained = retainedFrame?.game?.rect != null
      const frame = retained
        ? retainedFrame
        : await session.live?.freeze(session.controller.signal)
      if (!this.currentDetectionOperation(session, operationGeneration, 'CAPTURING')) {
        return session.view
      }
      if (frame == null) {
        throw new ApplicationError('SETUP_SOURCE_LOST', 'Окно игры закрыто или свёрнуто')
      }
      if (!frame.game?.rect) {
        throw new ApplicationError(
          'SETUP_GAME_NOT_FOUND',
          'Не вижу игру в окне — сделайте кадр ещё раз',
        )
      }
      session.frame = frame
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'SELECTING',
        frameSize: frame.size,
        game: {
          viewport: this.gameViewport(frame),
          aspect: frame.game.aspect,
          source: retained ? 'auto' : 'freeze',
        },
        regionOrigins: session.view.regionOrigins ?? {
          trigger: 'manual',
          nickname: 'manual',
          topLeftEvidence: 'manual',
        },
        error: null,
      })
    } catch (error) {
      if (this.currentDetectionOperation(session, operationGeneration, 'CAPTURING')) {
        session.view = SetupSessionViewSchema.parse({
          ...session.view,
          state: 'FAILED',
          error: publicFailure(error),
        })
      }
    }
    await this.stopLive(session)
    return session.view
  }

  private detectionStateInvalid(): ApplicationError {
    return new ApplicationError(
      'SETUP_DETECTION_STATE_INVALID',
      'Настройка изменилась — откройте её ещё раз',
    )
  }

  private launchDetection(session: InternalSession): void {
    session.detectionController?.abort()
    const controller = new AbortController()
    session.detectionController = controller
    session.frame = null
    session.legacyTriggerProfile = null
    session.vsOrientation = null
    delete session.detectionPreview
    delete session.autoConfidence
    const startedAt = this.now()
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'DETECTING',
      frameSize: null,
      game: null,
      regionOrigins: null,
      triggerKind: null,
      triggerProfile: null,
      regions: {
        ...session.view.regions,
        trigger: null,
        nickname: null,
        topLeftEvidence: null,
      },
      error: null,
      detection: {
        status: 'running',
        phase: null,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + 60_000).toISOString(),
        game: null,
        failure: null,
        frameAvailable: false,
        nameCheck: { status: 'pending', text: null },
      },
    })
    session.detectionOperation = this.runDetection(
      session,
      session.view.generation,
      controller,
    )
  }

  private currentDetectionOperation(
    session: InternalSession,
    generation: number,
    state: SetupSessionView['state'] = 'DETECTING',
  ): boolean {
    if (this.#session !== session || session.controller.signal.aborted) return false
    if (!this.hasCurrentAuthContext(session)) {
      this.cancelForAuthTransition()
      return false
    }
    return this.isCurrentOperation(session, generation, state)
  }

  private gameViewport(frame: CapturedFrame): NormalizedRect {
    const rect = frame.game?.rect
    if (!rect) {
      throw new ApplicationError(
        'SETUP_GAME_NOT_FOUND',
        'Не вижу игру в окне — сделайте кадр ещё раз',
      )
    }
    return NormalizedRectSchema.parse({
      x: rect.x / frame.size.width,
      y: rect.y / frame.size.height,
      width: rect.width / frame.size.width,
      height: rect.height / frame.size.height,
    })
  }

  private async runDetection(
    session: InternalSession,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const { promise: cancelled, reject: rejectCancellation } =
      Promise.withResolvers<never>()
    const rejectCancelled = () =>
      rejectCancellation(
        new ApplicationError('CAPTURE_PREPARATION_CANCELLED', 'Настройка отменена'),
      )
    controller.signal.addEventListener('abort', rejectCancelled, { once: true })
    const current = () =>
      !controller.signal.aborted &&
      session.view.detection?.status === 'running' &&
      this.currentDetectionOperation(session, generation)
    try {
      const live = session.live
      if (live === undefined) {
        this.failDetection(session, 'AUTO_SOURCE_LOST')
        return
      }
      const operation = live.analyze(
        (progress: AnalysisProgress) => {
          if (!current()) return
          session.view = SetupSessionViewSchema.parse({
            ...session.view,
            detection: {
              ...session.view.detection,
              phase: progress.phase,
            },
          })
        },
        (preview) => {
          if (current()) session.detectionPreview = preview
        },
        controller.signal,
      )
      const timeout = Promise.withResolvers<never>()
      timer = setTimeout(() => {
        timeout.reject(
          new ApplicationError(
            'AUTO_INTERNAL_TIMEOUT',
            'Не получилось настроить автоматически',
          ),
        )
        void this.stopLive(session)
      }, 65_000)
      const analyzed = await Promise.race([operation, cancelled, timeout.promise])
      clearTimeout(timer)
      if (!current()) return
      this.retainDetectionCandidate(session, analyzed.result, analyzed.frame)
      if (!analyzed.result.ok) {
        this.failDetection(session, analyzed.result.code)
        return
      }
      if (!session.frame?.game?.rect) {
        this.failDetection(session, 'AUTO_INTERNAL_ERROR')
        return
      }
      const trigger = NormalizedRectSchema.parse(session.view.regions.trigger)
      const canonicalTrigger = canonicalizeNormalizedRect(trigger, session.frame.size)
      // Orientation acceptance is authoritative. The ancillary analyzer supplies
      // the structural and legacy profiles required by persistence/projection.
      const analysis = await Promise.race([
        this.capture.analyze(
          session.frame,
          canonicalTrigger,
          controller.signal,
          session.frame.game.rect,
        ),
        cancelled,
      ])
      if (!current()) return
      session.legacyTriggerProfile = analysis.legacyProfile
      session.vsOrientation = analyzed.result.trigger
      session.autoConfidence = analyzed.result.confidence
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'SELECTING',
        generation: generation + 1,
        regions: { ...session.view.regions, trigger: canonicalTrigger },
        triggerProfile: analysis.profile,
        triggerKind: 'vs_edge_orientation',
        detection: { ...session.view.detection, status: 'succeeded', failure: null },
      })
      void this.checkDetectionName(session, controller)
    } catch (error) {
      if (!current()) return
      const code = AutoSetupCodeSchema.safeParse(
        error instanceof ApplicationError ? error.code : null,
      )
      this.failDetection(session, code.success ? code.data : 'AUTO_INTERNAL_ERROR')
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', rejectCancelled)
    }
  }

  private retainDetectionCandidate(
    session: InternalSession,
    result: AnalysisResult,
    frame: CapturedFrame | null,
  ): void {
    const game = result.game
    session.frame = frame
    if (frame !== null && game != null) {
      session.frame = { ...frame, game: { ...game, frames: 8 } }
    }
    const retainedFrame = session.frame
    const retainedGame = retainedFrame?.game
    const viewport =
      retainedFrame !== null && retainedGame?.rect
        ? this.gameViewport(retainedFrame)
        : null
    const toFrame = (rect: NormalizedRect, viewport: NormalizedRect): NormalizedRect =>
      NormalizedRectSchema.parse({
        x: viewport.x + rect.x * viewport.width,
        y: viewport.y + rect.y * viewport.height,
        width: rect.width * viewport.width,
        height: rect.height * viewport.height,
      })
    const regions =
      viewport !== null && result.regions != null
        ? {
            trigger: toFrame(result.regions.trigger, viewport),
            nickname: toFrame(result.regions.nickname, viewport),
            topLeftEvidence: toFrame(result.regions.topLeftEvidence, viewport),
          }
        : null
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      frameSize: frame?.size ?? null,
      game:
        viewport === null || !retainedGame?.rect
          ? null
          : {
              viewport,
              aspect: retainedGame.aspect,
              source: 'auto',
            },
      regions: { ...session.view.regions, ...regions },
      regionOrigins:
        regions === null
          ? null
          : {
              trigger: 'auto',
              nickname: 'auto',
              topLeftEvidence: 'auto',
            },
      detection: {
        ...session.view.detection,
        game:
          viewport === null || !retainedGame?.rect
            ? null
            : { viewport, aspect: retainedGame.aspect },
        frameAvailable: frame !== null,
      },
    })
  }

  private failDetection(session: InternalSession, code: AutoSetupCode): void {
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      detection: {
        ...session.view.detection,
        status: 'failed',
        failure: { code },
        nameCheck: { status: 'skipped', text: null },
      },
    })
  }

  private async checkDetectionName(
    session: InternalSession,
    controller: AbortController,
  ): Promise<void> {
    let nameCheck: SetupNameCheck = { status: 'skipped', text: null }
    try {
      if (this.nameChecker !== undefined) {
        const frame = session.frame
        const nickname = session.view.regions.nickname
        if (frame === null || nickname === null) {
          throw new ApplicationError('SETUP_INCOMPLETE', 'Setup crop is unavailable')
        }
        const crop = await this.capture.crop(frame, nickname, controller.signal)
        if (
          controller.signal.aborted ||
          session.controller.signal.aborted ||
          this.#session !== session
        )
          return
        if (!this.hasCurrentAuthContext(session)) {
          this.cancelForAuthTransition()
          return
        }
        nameCheck =
          crop.byteLength === 0
            ? { status: 'unavailable', text: null }
            : await this.nameChecker.checkSetupName(crop, controller.signal)
      }
    } catch {
      nameCheck = { status: 'unavailable', text: null }
    }
    if (
      this.#session !== session ||
      session.controller.signal.aborted ||
      controller.signal.aborted ||
      session.detectionController !== controller
    )
      return
    if (!this.hasCurrentAuthContext(session)) {
      this.cancelForAuthTransition()
      return
    }
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      detection: { ...session.view.detection, nameCheck },
    })
  }

  private async stopLive(session: InternalSession): Promise<void> {
    const live = session.live
    delete session.live
    delete session.detectionPreview
    if (live !== undefined) await live.stop()
  }
  private async performStart(
    selector: SetupCaptureSelector,
    preference: CapturePreference,
    kind: SetupSessionView['kind'],
    preparedFrame: CapturedFrame | undefined,
    requestedProfile: Omit<SetupCaptureProfileTarget, 'userId'> | undefined,
  ): Promise<SetupSessionView> {
    if (
      this.#session !== null &&
      !['COMMITTED', 'CANCELLED', 'FAILED'].includes(this.#session.view.state)
    ) {
      throw new ApplicationError(
        'SETUP_ALREADY_ACTIVE',
        'A capture setup is already active',
      )
    }
    const authGeneration = this.auth.getContextGeneration()
    const user = this.auth.getView().user
    const profileTarget =
      kind === 'capture' || requestedProfile !== undefined
        ? await this.resolveProfileTarget(user?.id ?? null, requestedProfile)
        : null
    const controller = new AbortController()
    if (
      this.auth.getContextGeneration() !== authGeneration ||
      this.auth.getView().user?.id !== user?.id
    ) {
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in session changed while setup was starting',
      )
    }
    if (this.#session !== null) await this.stopLive(this.#session)
    const session: InternalSession = {
      selector,
      frame: null,
      controller,
      commitLocked: false,
      legacyTriggerProfile: null,
      vsOrientation: null,
      profileTarget,
      authGeneration,
      view: SetupSessionViewSchema.parse({
        kind,
        sessionId: randomUUID(),
        generation: 0,
        state: 'CREATED',
        source: preference,
        profileId: profileTarget?.profileId ?? null,
        profileName: profileTarget?.profileName ?? null,
        frameSize: null,
        game: null,
        regionOrigins: null,
        detection: null,
        triggerKind: null,
        regions: {
          trigger: null,
          nickname: null,
          topLeftEvidence: null,
          resultTrigger: null,
          resultData: null,
        },
        triggerProfile: null,
        error: null,
      }),
    }
    this.#session = session
    session.view = SetupSessionViewSchema.parse({ ...session.view, state: 'CAPTURING' })
    try {
      session.frame =
        preparedFrame ?? (await this.capture.capture(selector, controller.signal))
      if (this.#session !== session || controller.signal.aborted) return session.view
      const game = kind === 'capture' ? session.frame.game : undefined
      if (kind === 'capture' && !game?.rect) {
        throw new ApplicationError(
          'SETUP_GAME_NOT_FOUND',
          'Не вижу игру в окне — сделайте кадр ещё раз',
        )
      }
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'SELECTING',
        generation: session.view.generation + 1,
        frameSize: session.frame.size,
        game: !game?.rect
          ? null
          : {
              viewport: {
                x: game.rect.x / session.frame.size.width,
                y: game.rect.y / session.frame.size.height,
                width: game.rect.width / session.frame.size.width,
                height: game.rect.height / session.frame.size.height,
              },
              aspect: game.aspect,
              source: 'freeze',
            },
        regionOrigins:
          kind === 'capture'
            ? { trigger: 'manual', nickname: 'manual', topLeftEvidence: 'manual' }
            : null,
      })
    } catch (error) {
      if (this.#session === session && !controller.signal.aborted) {
        session.view = SetupSessionViewSchema.parse({
          ...session.view,
          state: 'FAILED',
          generation: session.view.generation + 1,
          error: publicFailure(error),
        })
      }
    }
    return session.view
  }

  async startPredictionResult(
    profileId?: string,
    expectedRevision?: number,
  ): Promise<SetupSessionView> {
    const authGeneration = this.auth.getContextGeneration()
    if (this.targetResolver === undefined) {
      throw new ApplicationError(
        'RESULT_SETUP_UNAVAILABLE',
        'Result setup is unavailable',
      )
    }
    const resolved =
      profileId === undefined
        ? await this.targetResolver.resolveActiveProfile()
        : await this.targetResolver.resolveProfileTarget(profileId)
    if (
      expectedRevision !== undefined &&
      expectedRevision !== resolved.collectionRevision
    ) {
      throw new ApplicationError(
        'CAPTURE_PROFILE_STALE',
        'Capture profiles changed; reload before configuring result zones',
      )
    }
    const user = this.auth.getView().user
    if (
      user?.id !== resolved.userId ||
      authGeneration !== this.auth.getContextGeneration()
    ) {
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in user changed while result setup was starting',
      )
    }
    return this.start(
      resolved.selector,
      resolved.configuration.sourceBinding.identity,
      'predictionResult',
      undefined,
      {
        profileId: resolved.profileId,
        profileName: resolved.profileName,
        expectedRevision: resolved.collectionRevision,
      },
    )
  }

  getSession(): SetupSessionView {
    if (this.#session === null)
      throw new ApplicationError('SETUP_NOT_ACTIVE', 'No setup is active')
    if (!this.hasCurrentAuthContext(this.#session)) {
      this.cancelForAuthTransition()
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in session changed while setup was open',
      )
    }
    return this.#session.view
  }

  getFrame(sessionId: string, generation: number): SetupFrame {
    const session = this.assertCommand(sessionId, generation)
    if (session.frame === null)
      throw new ApplicationError('SETUP_FRAME_UNAVAILABLE', 'Setup frame is unavailable')
    return SetupFrameSchema.parse({
      sessionId,
      generation,
      size: session.frame.size,
      mimeType: 'image/png',
      byteLength: session.frame.png.byteLength,
      bytes: new Uint8Array(session.frame.png),
    })
  }

  setRegion(
    sessionId: string,
    generation: number,
    region: RegionKind,
    rect: NormalizedRect,
  ): SetupSessionView {
    const session = this.assertCommand(sessionId, generation)
    if (session.view.state !== 'SELECTING') {
      throw new ApplicationError('SETUP_STATE_INVALID', 'Regions cannot be changed now')
    }
    const allowed =
      session.view.kind === 'capture'
        ? ['trigger', 'nickname', 'topLeftEvidence']
        : ['resultTrigger', 'resultData']
    if (!allowed.includes(region)) {
      throw new ApplicationError(
        'SETUP_REGION_INVALID',
        'Region does not belong to this setup mode',
      )
    }
    const validated = NormalizedRectSchema.parse(rect)
    if (session.view.kind === 'capture') {
      const game = session.frame?.game
      if (session.frame === null || !game?.rect) {
        throw new ApplicationError(
          'SETUP_GAME_NOT_FOUND',
          'Не вижу игру в окне — сделайте кадр ещё раз',
        )
      }
      frameToGameRect(validated, session.frame.size, game.rect)
    }
    const previous = session.view.regions[region]
    if (
      (region === 'trigger' || region === 'nickname' || region === 'topLeftEvidence') &&
      session.view.regionOrigins?.[region] === 'auto' &&
      previous !== null &&
      previous.x === validated.x &&
      previous.y === validated.y &&
      previous.width === validated.width &&
      previous.height === validated.height
    ) {
      return session.view
    }
    if (region === 'trigger' || region === 'resultTrigger') {
      session.legacyTriggerProfile = null
      session.vsOrientation = null
    }
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      generation: generation + 1,
      regions: { ...session.view.regions, [region]: validated },
      regionOrigins:
        session.view.regionOrigins === null
          ? null
          : { ...session.view.regionOrigins, [region]: 'manual' },
      ...(region === 'trigger' || region === 'resultTrigger'
        ? { triggerProfile: null, triggerKind: null }
        : {}),
      error: null,
    })
    return session.view
  }

  async finish(
    sessionId: string,
    generation: number,
    region: RegionKind,
    rect: NormalizedRect,
  ): Promise<SetupSessionView> {
    const session = this.assertCommand(sessionId, generation)
    const finalRegion = session.view.kind === 'capture' ? 'topLeftEvidence' : 'resultData'
    if (region !== finalRegion) {
      throw new ApplicationError(
        'SETUP_REGION_INVALID',
        'Only the final setup region can complete configuration',
      )
    }

    let view = this.setRegion(sessionId, generation, region, rect)
    if (view.triggerProfile === null) {
      view = await this.analyzeTrigger(view.sessionId, view.generation)
      if (view.state !== 'SELECTING' || view.triggerProfile === null) return view
    }
    view = this.review(view.sessionId, view.generation)
    return this.commit(view.sessionId, view.generation)
  }

  async analyzeTrigger(sessionId: string, generation: number): Promise<SetupSessionView> {
    const session = this.assertCommand(sessionId, generation)
    if (session.view.state !== 'SELECTING' || session.frame === null) {
      throw new ApplicationError('SETUP_STATE_INVALID', 'Trigger cannot be analyzed now')
    }
    const triggerRegion =
      session.view.kind === 'predictionResult' ? 'resultTrigger' : 'trigger'
    const trigger = session.view.regions[triggerRegion]
    if (trigger === null)
      throw new ApplicationError(
        'SETUP_REGION_MISSING',
        'Select the trigger region first',
      )
    session.view = SetupSessionViewSchema.parse({ ...session.view, state: 'ANALYZING' })
    session.legacyTriggerProfile = null
    session.vsOrientation = null
    const operationGeneration = generation
    try {
      const canonicalTrigger = canonicalizeNormalizedRect(trigger, session.frame.size)
      const analysis = await this.capture.analyze(
        session.frame,
        canonicalTrigger,
        session.controller.signal,
        session.view.kind === 'capture' ? (session.frame.game?.rect ?? null) : null,
      )
      if (!this.currentDetectionOperation(session, operationGeneration, 'ANALYZING')) {
        return session.view
      }
      session.legacyTriggerProfile = analysis.legacyProfile
      session.vsOrientation =
        session.view.kind === 'capture' ? analysis.vsOrientation : null
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'SELECTING',
        generation: generation + 1,
        regions: { ...session.view.regions, [triggerRegion]: canonicalTrigger },
        triggerProfile: analysis.profile,
        triggerKind:
          session.vsOrientation === null ? 'structural' : 'vs_edge_orientation',
        error: null,
      })
    } catch (error) {
      if (this.currentDetectionOperation(session, operationGeneration, 'ANALYZING')) {
        session.view = SetupSessionViewSchema.parse({
          ...session.view,
          state: 'SELECTING',
          generation: generation + 1,
          error: publicFailure(error),
        })
      }
    }
    return session.view
  }

  review(sessionId: string, generation: number): SetupSessionView {
    const session = this.assertCommand(sessionId, generation)
    if (
      session.view.state !== 'SELECTING' ||
      session.view.triggerProfile === null ||
      session.legacyTriggerProfile === null
    ) {
      throw new ApplicationError('SETUP_INCOMPLETE', 'Analyze the trigger before review')
    }
    if (session.view.kind === 'capture')
      NormalizedRegionsSchema.parse({
        trigger: session.view.regions.trigger,
        nickname: session.view.regions.nickname,
        topLeftEvidence: session.view.regions.topLeftEvidence,
      })
    else if (
      session.view.regions.resultTrigger === null ||
      session.view.regions.resultData === null
    ) {
      throw new ApplicationError('SETUP_INCOMPLETE', 'Select both result regions')
    }
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'REVIEW',
      generation: generation + 1,
      error: null,
    })
    return session.view
  }

  async commit(sessionId: string, generation: number): Promise<SetupSessionView> {
    const session = this.assertCommand(sessionId, generation)
    if (
      session.view.state !== 'REVIEW' ||
      session.frame === null ||
      session.view.triggerProfile === null ||
      session.legacyTriggerProfile === null
    ) {
      throw new ApplicationError('SETUP_INCOMPLETE', 'Setup is not ready to save')
    }
    if (session.view.kind === 'predictionResult') {
      return this.#runCaptureCommit(() =>
        this.commitPredictionResult(session, generation),
      )
    }
    return this.#runCaptureCommit(() => this.commitCapture(session, generation))
  }

  private async commitCapture(
    session: InternalSession,
    generation: number,
  ): Promise<SetupSessionView> {
    this.assertCommand(session.view.sessionId, generation)
    if (session.view.state !== 'REVIEW') {
      throw new ApplicationError(
        'SETUP_STATE_INVALID',
        'Setup is no longer ready to save',
      )
    }
    const frame = session.frame
    const triggerProfile = session.view.triggerProfile
    const legacyTriggerProfile = session.legacyTriggerProfile
    if (frame === null || triggerProfile === null || legacyTriggerProfile === null) {
      throw new ApplicationError('SETUP_INCOMPLETE', 'Setup is not ready to save')
    }
    const game = frame.game
    if (session.view.game === null || !game?.rect) {
      throw new ApplicationError(
        'SETUP_GAME_NOT_FOUND',
        'Не вижу игру в окне — сделайте кадр ещё раз',
      )
    }
    const regions = NormalizedRegionsSchema.parse({
      trigger: session.view.regions.trigger,
      nickname: session.view.regions.nickname,
      topLeftEvidence: session.view.regions.topLeftEvidence,
    })
    const user = this.auth.getView().user
    const profileTarget = session.profileTarget
    this.#assertCaptureCommitAllowed()
    session.commitLocked = true
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'SAVING',
      error: null,
    })
    void this.stopLive(session)
    const token = await this.auth.getAccessToken()
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (
      token === null ||
      user?.id === undefined ||
      user.id !== profileTarget?.userId ||
      !this.hasCurrentAuthContext(session)
    ) {
      session.commitLocked = false
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'REVIEW',
        generation: generation + 1,
        error: { code: 'AUTH_REQUIRED', message: 'Sign in again to save setup' },
      })
      return session.view
    }
    const profileStatus = await this.repository.list(user.id)
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (!this.hasCurrentAuthContext(session)) {
      session.commitLocked = false
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'REVIEW',
        generation: generation + 1,
        error: {
          code: 'AUTH_CONTEXT_CHANGED',
          message: 'The signed-in session changed while capture setup was saving',
        },
      })
      return session.view
    }
    if ((profileStatus?.revision ?? 0) !== profileTarget.expectedRevision) {
      session.commitLocked = false
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'REVIEW',
        generation: generation + 1,
        error: {
          code: 'CAPTURE_PROFILE_STALE',
          message: 'Capture profiles changed while setup was open',
        },
      })
      return session.view
    }
    const existingProfile = profileStatus?.profiles.find(
      (profile) => profile.profileId === profileTarget.profileId,
    )
    if (
      (existingProfile === undefined &&
        (profileStatus?.profileCount ?? 0) >= MAX_CAPTURE_PROFILES) ||
      profileStatus?.profiles.some(
        (profile) =>
          profile.profileId !== profileTarget.profileId &&
          profile.profileName.toLocaleLowerCase('ru-RU') ===
            profileTarget.profileName.toLocaleLowerCase('ru-RU'),
      ) === true
    ) {
      session.commitLocked = false
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'REVIEW',
        generation: generation + 1,
        error: {
          code:
            existingProfile === undefined &&
            (profileStatus?.profileCount ?? 0) >= MAX_CAPTURE_PROFILES
              ? 'CAPTURE_PROFILE_LIMIT'
              : 'CAPTURE_PROFILE_NAME_CONFLICT',
          message: 'The capture profile cannot be created with the selected name',
        },
      })
      return session.view
    }
    const activateProfile = existingProfile === undefined || existingProfile.isActive
    const timestamp = this.now().toISOString()
    try {
      const previous = await this.repository.get(user.id, profileTarget.profileId)
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      if (!this.hasCurrentAuthContext(session)) {
        return this.captureCommitAuthFailure(session, generation)
      }
      const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
        schemaVersion: 3,
        userId: user.id,
        revision: (previous?.configuration.revision ?? 0) + 1,
        committedAt: timestamp,
        sourceBinding: {
          identity: session.view.source,
          lastVerifiedAt: timestamp,
        },
        calibration: GameRelativeCalibrationSchema.parse({
          schemaVersion: 2,
          coordinateSpace: 'game_relative',
          calibrationId: randomUUID(),
          revision: (previous?.configuration.calibration.revision ?? 0) + 1,
          layouts: [
            {
              layoutId: randomUUID(),
              layoutSource: 'setup',
              gameAspect: game.aspect,
              referenceFrameSize: frame.size,
              referenceGameRect: game.rect,
              windowChrome: game.chrome,
              expectedLayout: 'cr_battle_vs',
              triggerRegion: frameToGameRect(regions.trigger, frame.size, game.rect),
              nicknameRegion: frameToGameRect(regions.nickname, frame.size, game.rect),
              topLeftEvidenceRegion: frameToGameRect(
                regions.topLeftEvidence,
                frame.size,
                game.rect,
              ),
              trigger: session.vsOrientation ?? {
                kind: 'structural',
                profile: triggerProfile,
              },
              provenance: {
                trigger: {
                  origin: session.view.regionOrigins?.trigger ?? 'manual',
                  confidence:
                    session.view.regionOrigins?.trigger === 'auto'
                      ? (session.autoConfidence ?? null)
                      : null,
                  analyzerVersion:
                    session.vsOrientation?.algorithm ?? triggerProfile.analyzer.version,
                },
                nickname: {
                  origin: session.view.regionOrigins?.nickname ?? 'manual',
                  confidence:
                    session.view.regionOrigins?.nickname === 'auto'
                      ? (session.autoConfidence ?? null)
                      : null,
                  analyzerVersion:
                    session.view.regionOrigins?.nickname === 'auto' ? 'm9-geom-1' : null,
                },
                topLeftEvidence: {
                  origin: session.view.regionOrigins?.topLeftEvidence ?? 'manual',
                  confidence:
                    session.view.regionOrigins?.topLeftEvidence === 'auto'
                      ? (session.autoConfidence ?? null)
                      : null,
                  analyzerVersion:
                    session.view.regionOrigins?.topLeftEvidence === 'auto'
                      ? 'm9-geom-1'
                      : null,
                },
                viewport: {
                  origin: 'auto',
                  confidence: session.autoConfidence ?? null,
                  analyzerVersion: 'm9-geom-1',
                },
              },
              calibratedAt: timestamp,
            },
          ],
          validationStatus: 'validated',
          calibratedAt: timestamp,
        }),
      }
      const config = CaptureConfigurationSchema.parse({
        ...unsigned,
        fingerprint: captureConfigurationFingerprint(unsigned),
      })
      const layout =
        unsigned.calibration.coordinateSpace === 'game_relative'
          ? unsigned.calibration.layouts[0]
          : undefined
      if (layout === undefined) {
        throw new ApplicationError('SETUP_INCOMPLETE', 'Setup layout is unavailable')
      }
      const projection = buildLegacyProjection(
        frame,
        {
          trigger: gameToFrameRect(layout.triggerRegion, layout),
          nickname: gameToFrameRect(layout.nicknameRegion, layout),
          topLeftEvidence: gameToFrameRect(layout.topLeftEvidenceRegion, layout),
        },
        triggerProfile,
        legacyTriggerProfile,
        session.view.source,
        timestamp,
      )
      await this.repository.save(config, {
        profileId: profileTarget.profileId,
        profileName: profileTarget.profileName,
        expectedRevision: profileTarget.expectedRevision,
        activate: activateProfile,
      })
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        saveOutcome: {
          local: 'saved',
          projection: 'not_attempted',
          runtime: 'not_requested',
          warning: null,
        },
      })
      session.pendingSync = {
        captureFingerprint: config.fingerprint,
        requests: activateProfile
          ? [{ path: '/api/user/me/ocr-regions', body: projection }]
          : [],
      }
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      if (!this.hasCurrentAuthContext(session)) {
        this.cancelForAuthTransition()
        return session.view
      }
    } catch (error) {
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      session.frame = null
      session.legacyTriggerProfile = null
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'FAILED',
        generation: generation + 1,
        error: publicFailure(error),
        saveOutcome: {
          local: 'failed',
          projection: 'not_attempted',
          runtime: 'not_requested',
          warning: null,
        },
      })
      return session.view
    }
    return this.completeSaved(session, generation, activateProfile)
  }

  private async commitPredictionResult(
    session: InternalSession,
    generation: number,
  ): Promise<SetupSessionView> {
    this.assertCommand(session.view.sessionId, generation)
    if (session.view.state !== 'REVIEW') {
      throw new ApplicationError(
        'SETUP_STATE_INVALID',
        'Setup is no longer ready to save',
      )
    }
    if (
      session.frame === null ||
      session.view.triggerProfile === null ||
      session.legacyTriggerProfile === null ||
      session.view.regions.resultTrigger === null ||
      session.view.regions.resultData === null ||
      this.resultRepository === undefined ||
      this.authenticatedApi === undefined
    ) {
      throw new ApplicationError('SETUP_INCOMPLETE', 'Result setup is not ready to save')
    }
    const user = this.auth.getView().user
    const profileTarget = session.profileTarget
    if (user?.id === undefined || user.id !== profileTarget?.userId)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in again to save setup')
    const frame = session.frame
    const trigger = session.view.regions.resultTrigger
    const data = session.view.regions.resultData
    const profile = session.view.triggerProfile
    const legacyProfile = session.legacyTriggerProfile
    const timestamp = this.now().toISOString()
    session.commitLocked = true
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'SAVING',
      error: null,
    })
    const token = await this.auth.getAccessToken()
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (token === null || !this.hasCurrentAuthContext(session)) {
      return this.resultCommitFailure(
        session,
        generation,
        'AUTH_CONTEXT_CHANGED',
        'The signed-in user changed while result setup was saving',
      )
    }
    const profileStatus = await this.repository.list(profileTarget.userId)
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (!this.hasCurrentAuthContext(session)) {
      return this.resultCommitFailure(
        session,
        generation,
        'AUTH_CONTEXT_CHANGED',
        'The signed-in session changed while result setup was saving',
      )
    }
    const captureProfile = profileStatus?.profiles.find(
      (profileSummary) => profileSummary.profileId === profileTarget.profileId,
    )
    if (
      profileStatus?.revision !== profileTarget.expectedRevision ||
      captureProfile === undefined
    ) {
      return this.resultCommitFailure(
        session,
        generation,
        'CAPTURE_PROFILE_STALE',
        'The capture profile changed while result setup was open',
      )
    }
    const captureReference = {
      target_type: session.view.source.kind === 'window' ? 'window' : 'screen',
      target_id:
        session.view.source.kind === 'window'
          ? 'window-preference'
          : session.view.source.displayId,
      target_name: session.view.source.label,
      source_frame_size: frame.size,
      selected_target: {
        targetType: session.view.source.kind === 'window' ? 'window' : 'screen',
        name: session.view.source.label,
        executableName:
          session.view.source.kind === 'window'
            ? session.view.source.executableLabel
            : null,
      },
      created_at: timestamp,
    }
    const triggerPixels = normalizedToPixelRect(trigger, frame.size)
    const dataPixels = normalizedToPixelRect(data, frame.size)
    const triggerPayload = {
      ...triggerPixels,
      ratio: trigger,
      screen_resolution: frame.size,
      capture_reference: captureReference,
      trigger_profile: buildLegacyTriggerProfile(trigger, profile, legacyProfile),
    }
    const dataPayload = {
      ...dataPixels,
      ratio: data,
      screen_resolution: frame.size,
      capture_reference: captureReference,
    }
    try {
      const resultProfileId = profileTarget.profileId
      const previous = await this.resultRepository.load(user.id, resultProfileId)
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      if (!this.hasCurrentAuthContext(session)) {
        return this.resultCommitFailure(
          session,
          generation,
          'AUTH_CONTEXT_CHANGED',
          'The signed-in session changed while result setup was saving',
        )
      }
      const unsigned: Omit<PredictionResultConfiguration, 'fingerprint'> = {
        schemaVersion: 2,
        userId: user.id,
        captureProfileId: resultProfileId,
        captureConfigurationRevision: captureProfile.configurationRevision,
        captureConfigurationFingerprint: captureProfile.configurationFingerprint,
        ...(captureProfile.calibrationId === undefined
          ? {}
          : { captureCalibrationId: captureProfile.calibrationId }),
        revision: (previous?.revision ?? 0) + 1,
        committedAt: timestamp,
        source: session.view.source,
        frameSize: frame.size,
        trigger,
        data,
        triggerProfile: profile,
      }
      const saved = PredictionResultConfigurationSchema.parse({
        ...unsigned,
        fingerprint: predictionResultFingerprint(unsigned),
      })
      await this.resultRepository.save(saved, resultProfileId)
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        saveOutcome: {
          local: 'saved',
          projection: 'not_attempted',
          runtime: 'not_requested',
          warning: null,
        },
      })
      session.pendingSync = {
        captureFingerprint: captureProfile.configurationFingerprint,
        resultFingerprint: saved.fingerprint,
        requests: captureProfile.isActive
          ? [
              { path: '/api/streamer/result-trigger-area', body: triggerPayload },
              { path: '/api/streamer/result-data-area', body: dataPayload },
            ]
          : [],
      }
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      if (!this.hasCurrentAuthContext(session)) {
        this.cancelForAuthTransition()
        return session.view
      }
    } catch {
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      session.frame = null
      session.legacyTriggerProfile = null
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'FAILED',
        generation: generation + 1,
        error: {
          code: 'RESULT_SETUP_LOCAL_COMMIT_FAILED',
          message:
            'Result zones could not be saved locally. The server projection was not changed.',
        },
        saveOutcome: {
          local: 'failed',
          projection: 'not_attempted',
          runtime: 'not_requested',
          warning: null,
        },
      })
      return session.view
    }
    return this.completeSaved(session, generation, false)
  }

  private async completeSaved(
    session: InternalSession,
    generation: number,
    restartCapture: boolean,
    recheck = false,
  ): Promise<SetupSessionView> {
    await this.stopLive(session)
    session.frame = null
    session.legacyTriggerProfile = null
    let projection: 'synced' | 'failed' | 'not_required'
    try {
      projection = await this.syncSaved(session, recheck)
    } catch (error) {
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      if (!this.hasCurrentAuthContext(session)) {
        this.cancelForAuthTransition()
        return session.view
      }
      if (error instanceof ApplicationError && error.code === 'CAPTURE_PROFILE_STALE') {
        session.commitLocked = false
        session.view = SetupSessionViewSchema.parse({
          ...session.view,
          state: 'COMMITTED',
          generation: generation + 1,
          error: error.toPublicError(),
          saveOutcome: {
            local: 'saved',
            projection: 'failed',
            runtime: 'not_requested',
            warning: 'SETUP_SYNC_FAILED',
          },
        })
        return session.view
      }
      projection = 'failed'
    }
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (!this.hasCurrentAuthContext(session)) {
      this.cancelForAuthTransition()
      return session.view
    }
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      saveOutcome: {
        local: 'saved',
        projection,
        runtime: session.view.saveOutcome?.runtime ?? 'not_requested',
        warning: projection === 'failed' ? 'SETUP_SYNC_FAILED' : null,
      },
    })
    let runtime = session.view.saveOutcome?.runtime ?? 'not_requested'
    if (restartCapture) {
      try {
        runtime = await this.#captureCommitted(true)
      } catch {
        runtime = 'failed'
      }
    }
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (!this.hasCurrentAuthContext(session)) {
      this.cancelForAuthTransition()
      return session.view
    }
    session.commitLocked = false
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'COMMITTED',
      generation: generation + 1,
      error: null,
      saveOutcome: {
        local: 'saved',
        projection,
        runtime,
        warning:
          projection === 'failed'
            ? 'SETUP_SYNC_FAILED'
            : runtime === 'failed'
              ? 'SETUP_RUNTIME_FAILED'
              : null,
      },
    })
    if (projection !== 'failed') delete session.pendingSync
    return session.view
  }

  private async syncSaved(
    session: InternalSession,
    recheck: boolean,
  ): Promise<'synced' | 'failed' | 'not_required'> {
    const pending = session.pendingSync
    const target = session.profileTarget
    if (pending === undefined || pending.requests.length === 0) return 'not_required'
    if (target === null || !this.hasCurrentAuthContext(session)) return 'failed'
    if (recheck) {
      const current = await this.repository.get(target.userId, target.profileId)
      const collection = await this.repository.list(target.userId)
      const result =
        pending.resultFingerprint === undefined
          ? null
          : await this.resultRepository?.load(target.userId, target.profileId)
      if (
        current?.configuration.fingerprint !== pending.captureFingerprint ||
        collection?.activeProfileId !== target.profileId ||
        (pending.resultFingerprint !== undefined &&
          result?.fingerprint !== pending.resultFingerprint)
      ) {
        throw new ApplicationError(
          'CAPTURE_PROFILE_STALE',
          'Reload the saved profile before syncing changed calibration',
        )
      }
    }
    const token = await this.auth.getAccessToken()
    if (token === null || !this.hasCurrentAuthContext(session)) return 'failed'
    for (const request of pending.requests) {
      const result = await this.api.request({
        method: 'POST',
        ...request,
        accessToken: token,
        schema: SaveResponseSchema,
        signal: session.controller.signal,
      })
      if (
        !result.ok ||
        !this.hasCurrentAuthContext(session) ||
        session.controller.signal.aborted
      )
        return 'failed'
    }
    return 'synced'
  }

  retrySync(sessionId: string, generation: number): Promise<SetupSessionView> {
    return this.#runCaptureCommit(async () => {
      const session = this.#session
      if (session?.view.sessionId !== sessionId || session.view.generation !== generation)
        throw new ApplicationError('SETUP_SESSION_STALE', 'Setup session changed')
      if (!this.hasCurrentAuthContext(session))
        throw new ApplicationError(
          'AUTH_CONTEXT_CHANGED',
          'The signed-in session changed',
        )
      if (
        session.view.state !== 'COMMITTED' ||
        session.view.saveOutcome?.local !== 'saved' ||
        !['failed', 'not_attempted'].includes(session.view.saveOutcome.projection)
      )
        throw new ApplicationError(
          'SETUP_STATE_INVALID',
          'There is no failed saved projection to retry',
        )
      session.commitLocked = true
      session.view = SetupSessionViewSchema.parse({ ...session.view, state: 'SAVING' })
      return this.completeSaved(session, generation, false, true)
    })
  }

  private resultCommitFailure(
    session: InternalSession,
    generation: number,
    code: string,
    message: string,
  ): SetupSessionView {
    session.commitLocked = false
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'REVIEW',
      generation: generation + 1,
      error: { code, message },
    })
    return session.view
  }

  private captureCommitAuthFailure(
    session: InternalSession,
    generation: number,
  ): SetupSessionView {
    session.commitLocked = false
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'REVIEW',
      generation: generation + 1,
      error: {
        code: 'AUTH_CONTEXT_CHANGED',
        message: 'The signed-in session changed while capture setup was saving',
      },
    })
    return session.view
  }

  cancel(sessionId: string, generation: number): SetupSessionView {
    const session = this.assertCommand(sessionId, generation)
    if (session.commitLocked) {
      throw new ApplicationError(
        'SETUP_SAVE_IN_PROGRESS',
        'Configuration is completing its atomic save',
      )
    }
    session.controller.abort()
    session.detectionController?.abort()
    void this.stopLive(session)
    session.frame = null
    session.legacyTriggerProfile = null
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'CANCELLED',
      generation: generation + 1,
      error: null,
    })
    return session.view
  }

  cancelForAuthTransition(): void {
    const session = this.#session
    if (session !== null) {
      session.detectionController?.abort()
      void this.stopLive(session)
      if (
        session.pendingSync !== undefined &&
        session.view.saveOutcome?.projection === 'not_attempted'
      ) {
        const projection =
          session.pendingSync.requests.length === 0 ? 'not_required' : 'failed'
        session.view = SetupSessionViewSchema.parse({
          ...session.view,
          saveOutcome: {
            ...session.view.saveOutcome,
            projection,
            warning: projection === 'failed' ? 'SETUP_SYNC_FAILED' : null,
          },
        })
      }
      delete session.pendingSync
    }
    if (
      session === null ||
      ['COMMITTED', 'CANCELLED', 'FAILED'].includes(session.view.state)
    ) {
      return
    }
    session.controller.abort()
    session.frame = null
    session.legacyTriggerProfile = null
    session.commitLocked = false
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'CANCELLED',
      generation: session.view.generation + 1,
      error: null,
    })
  }

  close(sessionId: string, generation: number): SetupSessionView {
    const session = this.#session
    if (session?.view.sessionId !== sessionId || session.view.generation !== generation) {
      throw new ApplicationError('SETUP_SESSION_STALE', 'Setup session is stale')
    }
    if (!this.hasCurrentAuthContext(session)) {
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in session changed while setup was open',
      )
    }
    session.detectionController?.abort()
    void this.stopLive(session)
    return ['COMMITTED', 'CANCELLED', 'FAILED'].includes(session.view.state)
      ? session.view
      : this.cancel(sessionId, generation)
  }

  async getStatus(): Promise<CaptureStatus> {
    const user = this.auth.getView().user
    if (user === null)
      return CaptureStatusSchema.parse({
        configured: false,
        revision: null,
        sourceLabel: null,
      })
    const config = await this.repository.load(user.id)
    return CaptureStatusSchema.parse({
      configured: config !== null,
      revision: config?.revision ?? null,
      sourceLabel: config?.sourceBinding.identity.label ?? null,
    })
  }

  private assertCommand(sessionId: string, generation: number): InternalSession {
    const session = this.#session
    if (session?.view.sessionId !== sessionId) {
      throw new ApplicationError('SETUP_SESSION_STALE', 'Setup session is stale')
    }
    if (session.view.generation !== generation) {
      throw new ApplicationError('SETUP_GENERATION_STALE', 'Setup command is stale')
    }
    if (!this.hasCurrentAuthContext(session)) {
      this.cancelForAuthTransition()
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in session changed while setup was open',
      )
    }
    if (['COMMITTED', 'CANCELLED', 'FAILED'].includes(session.view.state)) {
      throw new ApplicationError('SETUP_STATE_FINAL', 'Setup session has finished')
    }
    return session
  }

  private hasCurrentAuthContext(session: InternalSession): boolean {
    return (
      this.auth.getContextGeneration() === session.authGeneration &&
      this.auth.getView().user?.id === session.profileTarget?.userId
    )
  }

  private isCurrentOperation(
    session: InternalSession,
    generation: number,
    state: SetupSessionView['state'],
  ): boolean {
    return (
      this.#session === session &&
      session.view.generation === generation &&
      session.view.state === state
    )
  }

  private async resolveProfileTarget(
    userId: string | null,
    requested: Omit<SetupCaptureProfileTarget, 'userId'> | undefined,
  ): Promise<SetupCaptureProfileTarget> {
    if (userId === null)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to configure capture')
    if (requested !== undefined) {
      return {
        userId,
        profileId: CaptureProfileIdSchema.parse(requested.profileId),
        profileName: CaptureProfileNameSchema.parse(requested.profileName),
        expectedRevision: z
          .number()
          .int()
          .nonnegative()
          .parse(requested.expectedRevision),
      }
    }
    const profiles = await this.repository.list(userId)
    if (profiles === null) {
      return {
        userId,
        profileId: randomUUID(),
        profileName: 'Основной',
        expectedRevision: 0,
      }
    }
    const active = profiles.profiles.find(
      (profile) => profile.profileId === profiles.activeProfileId,
    )
    if (active === undefined) {
      throw new ApplicationError(
        'CAPTURE_PROFILE_NOT_FOUND',
        'The active capture profile is unavailable',
      )
    }
    return {
      userId,
      profileId: active.profileId,
      profileName: active.profileName,
      expectedRevision: profiles.revision,
    }
  }

  private serializedStart<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#startOperation.then(operation, operation)
    this.#startOperation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
