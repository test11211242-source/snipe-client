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
  normalizedToPixelRect,
  type CapturedFrame,
  type CaptureService,
} from './capture-service'

interface InternalSession {
  view: SetupSessionView
  selector: SetupCaptureSelector
  frame: CapturedFrame | null
  controller: AbortController
  commitLocked: boolean
  profileTarget: SetupCaptureProfileTarget | null
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
  source: CapturePreference,
  timestamp: string,
): LegacyOcrRegions {
  const regions = NormalizedRegionsSchema.parse(regionsInput)
  const trigger = normalizedToPixelRect(regions.trigger, frame.size)
  const normal = normalizedToPixelRect(regions.normal, frame.size)
  const precise = normalizedToPixelRect(regions.precise, frame.size)
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
      trigger_profile: {
        schema_version: 2,
        outer_ratio: regions.trigger,
        inner_ratio: profile.innerRect,
        template_gray_base64: profile.templateGrayBase64,
        thumbnail_hash: profile.ahash64,
        hash_algorithm: profile.hashAlgorithm,
        feature_mode: profile.featureMode,
        keypoints_count: profile.keypointsCount,
        normalized_template_size: profile.normalizedTemplateSize,
        hash_threshold: profile.hashMaxDistance,
        orb_distance_threshold: profile.orbDistanceThreshold,
        orb_min_good_matches: profile.orbMinGoodMatches,
        ncc_threshold: profile.nccMinScore,
        analyzer_version: profile.analyzer.version,
      },
    },
    normal_data_area: { ...normal, ratio: regions.normal },
    precise_data_area: { ...precise, ratio: regions.precise },
    screen_resolution: frame.size,
    updated_at: timestamp,
  })
}

export class SetupSessionService {
  #session: InternalSession | null = null
  #startOperation: Promise<void> = Promise.resolve()
  #assertCaptureCommitAllowed: () => void = () => undefined
  #captureCommitted: () => Promise<void> = () => Promise.resolve()
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
    captureCommitted: () => Promise<void>,
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
    const user = this.auth.getView().user
    const profileTarget =
      kind === 'capture' || requestedProfile !== undefined
        ? await this.resolveProfileTarget(user?.id ?? null, requestedProfile)
        : null
    const controller = new AbortController()
    const session: InternalSession = {
      selector,
      frame: null,
      controller,
      commitLocked: false,
      profileTarget,
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
          normal: null,
          precise: null,
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

  async startPredictionResult(): Promise<SetupSessionView> {
    if (this.targetResolver === undefined) {
      throw new ApplicationError(
        'RESULT_SETUP_UNAVAILABLE',
        'Result setup is unavailable',
      )
    }
    const resolved = await this.targetResolver.resolveActiveProfile()
    const user = this.auth.getView().user
    if (user?.id !== resolved.userId) {
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in user changed while result setup was starting',
      )
    }
    return this.start(
      resolved.selector,
      resolved.configuration.source,
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
        ? ['trigger', 'normal', 'precise']
        : ['resultTrigger', 'resultData']
    if (!allowed.includes(region)) {
      throw new ApplicationError(
        'SETUP_REGION_INVALID',
        'Region does not belong to this setup mode',
      )
    }
    const validated = NormalizedRectSchema.parse(rect)
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
    const finalRegion = session.view.kind === 'capture' ? 'precise' : 'resultData'
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
    const trigger =
      session.view.kind === 'predictionResult'
        ? session.view.regions.resultTrigger
        : session.view.regions.trigger
    if (trigger === null)
      throw new ApplicationError(
        'SETUP_REGION_MISSING',
        'Select the trigger region first',
      )
    session.view = SetupSessionViewSchema.parse({ ...session.view, state: 'ANALYZING' })
    const operationGeneration = generation
    try {
      const profile = await this.capture.analyze(
        session.frame,
        trigger,
        session.controller.signal,
      )
      if (
        this.#session !== session ||
        session.view.generation !== operationGeneration ||
        session.view.state !== 'ANALYZING'
      ) {
        return session.view
      }
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'SELECTING',
        generation: generation + 1,
        triggerProfile: profile,
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
    if (session.view.state !== 'SELECTING' || session.view.triggerProfile === null) {
      throw new ApplicationError('SETUP_INCOMPLETE', 'Analyze the trigger before review')
    }
    if (session.view.kind === 'capture')
      NormalizedRegionsSchema.parse({
        trigger: session.view.regions.trigger,
        normal: session.view.regions.normal,
        precise: session.view.regions.precise,
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
      session.view.triggerProfile === null
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
    if (frame === null || triggerProfile === null) {
      throw new ApplicationError('SETUP_INCOMPLETE', 'Setup is not ready to save')
    }
    const regions = NormalizedRegionsSchema.parse({
      trigger: session.view.regions.trigger,
      normal: session.view.regions.normal,
      precise: session.view.regions.precise,
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
    if (token === null || user?.id === undefined || user.id !== profileTarget?.userId) {
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
    if (
      (profileStatus?.revision ?? 0) !== profileTarget.expectedRevision ||
      !this.isCurrentOperation(session, generation, 'SAVING')
    ) {
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
    const timestamp = this.now().toISOString()
    const projection = buildLegacyProjection(
      frame,
      regions,
      triggerProfile,
      session.view.source,
      timestamp,
    )
    const remote = await this.api.request({
      method: 'POST',
      path: '/api/user/me/ocr-regions',
      body: projection,
      accessToken: token,
      schema: SaveResponseSchema,
      signal: session.controller.signal,
    })
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (this.auth.getView().user?.id !== profileTarget.userId) {
      session.commitLocked = false
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'REVIEW',
        generation: generation + 1,
        error: {
          code: 'AUTH_CONTEXT_CHANGED',
          message: 'The signed-in user changed while capture setup was saving',
        },
      })
      return session.view
    }
    if (!remote.ok) {
      session.commitLocked = false
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'REVIEW',
        generation: generation + 1,
        error: { code: remote.error.code, message: remote.error.message },
      })
      return session.view
    }

    try {
      const previous = await this.repository.get(user.id, profileTarget.profileId)
      const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
        schemaVersion: 1,
        userId: user.id,
        revision: (previous?.configuration.revision ?? 0) + 1,
        committedAt: timestamp,
        source: session.view.source,
        frameSize: frame.size,
        regions,
        triggerProfile,
      }
      const config = CaptureConfigurationSchema.parse({
        ...unsigned,
        fingerprint: captureConfigurationFingerprint(unsigned),
      })
      await this.repository.save(config, {
        profileId: profileTarget.profileId,
        profileName: profileTarget.profileName,
        expectedRevision: profileTarget.expectedRevision,
      })
      await this.#captureCommitted().catch(() => undefined)
    } catch (error) {
      session.frame = null
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'FAILED',
        generation: generation + 1,
        error: publicFailure(error),
      })
      return session.view
    }
    session.frame = null
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'COMMITTED',
      generation: generation + 1,
      error: null,
    })
    return session.view
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
    const timestamp = this.now().toISOString()
    session.commitLocked = true
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'SAVING',
      error: null,
    })
    const token = await this.auth.getAccessToken()
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (token === null || this.auth.getView().user?.id !== profileTarget.userId) {
      return this.resultCommitFailure(
        session,
        generation,
        'AUTH_CONTEXT_CHANGED',
        'The signed-in user changed while result setup was saving',
      )
    }
    const profileStatus = await this.repository.list(profileTarget.userId)
    if (
      !this.isCurrentOperation(session, generation, 'SAVING') ||
      profileStatus?.revision !== profileTarget.expectedRevision ||
      !profileStatus.profiles.some(
        (profileSummary) => profileSummary.profileId === profileTarget.profileId,
      )
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
      trigger_profile: {
        schema_version: 2,
        outer_ratio: trigger,
        inner_ratio: profile.innerRect,
        template_gray_base64: profile.templateGrayBase64,
        thumbnail_hash: profile.ahash64,
        hash_algorithm: profile.hashAlgorithm,
        feature_mode: profile.featureMode,
        keypoints_count: profile.keypointsCount,
        normalized_template_size: profile.normalizedTemplateSize,
        hash_threshold: profile.hashMaxDistance,
        orb_distance_threshold: profile.orbDistanceThreshold,
        orb_min_good_matches: profile.orbMinGoodMatches,
        ncc_threshold: profile.nccMinScore,
        analyzer_version: profile.analyzer.version,
      },
    }
    const triggerRemote = await this.api.request({
      method: 'POST',
      path: '/api/streamer/result-trigger-area',
      body: triggerPayload,
      accessToken: token,
      schema: SaveResponseSchema,
      signal: session.controller.signal,
    })
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (this.auth.getView().user?.id !== profileTarget.userId) {
      return this.resultCommitFailure(
        session,
        generation,
        'AUTH_CONTEXT_CHANGED',
        'The signed-in user changed while result setup was saving',
      )
    }
    if (!triggerRemote.ok)
      return this.resultCommitFailure(
        session,
        generation,
        triggerRemote.error.code,
        triggerRemote.error.message,
      )
    const dataRemote = await this.api.request({
      method: 'POST',
      path: '/api/streamer/result-data-area',
      body: {
        ...dataPixels,
        ratio: data,
        screen_resolution: frame.size,
        capture_reference: captureReference,
      },
      accessToken: token,
      schema: SaveResponseSchema,
      signal: session.controller.signal,
    })
    if (!this.isCurrentOperation(session, generation, 'SAVING')) return session.view
    if (this.auth.getView().user?.id !== profileTarget.userId) {
      return this.resultCommitFailure(
        session,
        generation,
        'AUTH_CONTEXT_CHANGED',
        'The signed-in user changed while result setup was saving',
      )
    }
    if (!dataRemote.ok) {
      return this.resultCommitFailure(
        session,
        generation,
        'RESULT_SETUP_PARTIAL_REMOTE',
        'Trigger area was saved remotely, but data area failed. Local configuration remains inactive; retry save.',
      )
    }
    try {
      const resultProfileId = profileTarget.profileId
      const previous = await this.resultRepository.load(user.id, resultProfileId)
      const unsigned: Omit<PredictionResultConfiguration, 'fingerprint'> = {
        schemaVersion: 1,
        userId: user.id,
        revision: (previous?.revision ?? 0) + 1,
        committedAt: timestamp,
        source: session.view.source,
        frameSize: frame.size,
        trigger,
        data,
        triggerProfile: profile,
      }
      await this.resultRepository.save(
        PredictionResultConfigurationSchema.parse({
          ...unsigned,
          fingerprint: predictionResultFingerprint(unsigned),
        }),
        resultProfileId,
      )
    } catch {
      session.frame = null
      session.view = SetupSessionViewSchema.parse({
        ...session.view,
        state: 'FAILED',
        generation: generation + 1,
        error: {
          code: 'RESULT_SETUP_LOCAL_COMMIT_FAILED',
          message:
            'Both result areas were saved remotely, but the local atomic commit failed. Local configuration remains inactive.',
        },
      })
      return session.view
    }
    session.frame = null
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'COMMITTED',
      generation: generation + 1,
      error: null,
    })
    return session.view
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
    session.view = SetupSessionViewSchema.parse({
      ...session.view,
      state: 'CANCELLED',
      generation: generation + 1,
      error: null,
    })
    return session.view
  }

  close(sessionId: string, generation: number): SetupSessionView {
    const session = this.#session
    if (session?.view.sessionId !== sessionId || session.view.generation !== generation) {
      throw new ApplicationError('SETUP_SESSION_STALE', 'Setup session is stale')
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
      sourceLabel: config?.source.label ?? null,
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
    if (['COMMITTED', 'CANCELLED', 'FAILED'].includes(session.view.state)) {
      throw new ApplicationError('SETUP_STATE_FINAL', 'Setup session has finished')
    }
    return session
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
