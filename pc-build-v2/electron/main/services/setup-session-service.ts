import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  CaptureConfigurationSchema,
  CaptureProfileIdSchema,
  CaptureProfileNameSchema,
  MAX_CAPTURE_PROFILES,
  CaptureStatusSchema,
  NormalizedRectSchema,
  NormalizedRegionsSchema,
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
} from '../../../shared/models/setup'
import type { SetupCaptureSelector } from '../domain/capture-source'
import {
  captureConfigurationFingerprint,
  type CaptureConfigurationRepository,
} from '../infrastructure/capture-configuration-repository'
import { createLayoutCalibration } from '../infrastructure/capture-profile-migration'
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

interface InternalSession {
  view: SetupSessionView
  selector: SetupCaptureSelector
  frame: CapturedFrame | null
  controller: AbortController
  commitLocked: boolean
  legacyTriggerProfile: LegacyTriggerAnalysis | null
  profileTarget: SetupCaptureProfileTarget | null
  authGeneration: number
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
    const session: InternalSession = {
      selector,
      frame: null,
      controller,
      commitLocked: false,
      legacyTriggerProfile: null,
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
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'SELECTING',
        generation: session.view.generation + 1,
        frameSize: session.frame.size,
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
    if (region === 'trigger' || region === 'resultTrigger') {
      session.legacyTriggerProfile = null
    }
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      generation: generation + 1,
      regions: { ...session.view.regions, [region]: validated },
      ...(region === 'trigger' || region === 'resultTrigger'
        ? { triggerProfile: null }
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
    const operationGeneration = generation
    try {
      const canonicalTrigger = canonicalizeNormalizedRect(trigger, session.frame.size)
      const analysis = await this.capture.analyze(
        session.frame,
        canonicalTrigger,
        session.controller.signal,
      )
      if (
        this.#session !== session ||
        session.view.generation !== operationGeneration ||
        session.view.state !== 'ANALYZING'
      ) {
        return session.view
      }
      session.legacyTriggerProfile = analysis.legacyProfile
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'SELECTING',
        generation: generation + 1,
        regions: { ...session.view.regions, [triggerRegion]: canonicalTrigger },
        triggerProfile: analysis.profile,
        error: null,
      })
    } catch (error) {
      if (session.view.state === 'ANALYZING') {
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
    const projection = buildLegacyProjection(
      frame,
      regions,
      triggerProfile,
      legacyTriggerProfile,
      session.view.source,
      timestamp,
    )
    try {
      const previous = await this.repository.get(user.id, profileTarget.profileId)
      if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
      if (!this.hasCurrentAuthContext(session)) {
        return this.captureCommitAuthFailure(session, generation)
      }
      const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
        schemaVersion: 2,
        userId: user.id,
        revision: (previous?.configuration.revision ?? 0) + 1,
        committedAt: timestamp,
        sourceBinding: {
          identity: session.view.source,
          lastVerifiedAt: timestamp,
        },
        calibration: createLayoutCalibration(
          previous?.configuration.calibration.calibrationId ?? randomUUID(),
          (previous?.configuration.calibration.revision ?? 0) + 1,
          frame.size,
          regions,
          triggerProfile,
          timestamp,
          'manual',
        ),
      }
      const config = CaptureConfigurationSchema.parse({
        ...unsigned,
        fingerprint: captureConfigurationFingerprint(unsigned),
      })
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
