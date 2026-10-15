import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  CaptureProfileNameSchema,
  GameLayoutSchema,
  CaptureProfilesViewSchema,
  CaptureStatusSchema,
  type CapturePreference,
  type CaptureProfilesView,
  type CaptureStatus,
  type PixelSize,
} from '../../../shared/models/capture'
import {
  CannotDeleteLastCaptureProfileError,
  CaptureProfileLimitError,
  CaptureProfileNameConflictError,
  CaptureProfileNotFoundError,
  CaptureProfileRevisionConflictError,
  type CaptureConfigurationRepository,
} from '../infrastructure/capture-configuration-repository'
import {
  predictionResultFingerprint,
  type PredictionResultConfigurationRepository,
} from '../infrastructure/prediction-result-configuration-repository'
import type { AuthSession } from './auth-session'
import type { CaptureTargetResolver } from './capture-target-resolver'
import type { MonitorSupervisor } from './monitor-supervisor'
import { predictionResultMatchesCapture } from '../../../shared/models/prediction-result'
import type { SetupRuntimeOutcome } from '../../../shared/models/setup'

import type { GameLayoutWire } from '../../../shared/contracts/monitor-protocol'
const ACTIVE_MONITOR_STATES = [
  'PREFLIGHT',
  'STARTING',
  'READY',
  'WAITING_SOURCE',
] as const

export interface CaptureProfileMutationResult {
  profiles: CaptureProfilesView
  monitor: Awaited<ReturnType<MonitorSupervisor['getView']>>
  capture: CaptureStatus
}

export class CaptureProfileService {
  #operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly auth: AuthSession,
    private readonly repository: CaptureConfigurationRepository,
    private readonly targetResolver: CaptureTargetResolver,
    private readonly monitor: MonitorSupervisor,
    private readonly predictionState: () => string = () => 'stopped',
    private readonly resultRepository?: PredictionResultConfigurationRepository,
  ) {}

  async getView(): Promise<CaptureProfilesView> {
    const generation = this.auth.getContextGeneration()
    const user = this.auth.getView().user
    if (user === null) return CaptureProfilesViewSchema.parse(this.emptyView())
    const status = await this.repository.list(user.id)
    if (status !== null) {
      const sourceHealth = await this.targetResolver.resolveProfiles(
        status.profiles.map((profile) => profile.profileId),
      )
      await Promise.all(
        status.profiles.map(async (profile) => {
          const error = sourceHealth.get(profile.profileId)
          if (error === null) {
            profile.sourceHealth = { state: 'available', reason: null }
          } else {
            const code =
              error instanceof ApplicationError
                ? error.code
                : 'SOURCE_METADATA_UNAVAILABLE'
            profile.sourceHealth = {
              state:
                code === 'SOURCE_NOT_FOUND'
                  ? 'missing'
                  : code === 'SOURCE_AMBIGUOUS'
                    ? 'ambiguous'
                    : 'metadata_unavailable',
              reason: code,
            }
            if (code === 'SOURCE_REBIND_REQUIRED')
              profile.calibrationHealth = 'needs_validation'
          }
          const result = await this.resultRepository?.load(user.id, profile.profileId)
          profile.resultConfigured =
            result != null &&
            predictionResultMatchesCapture(result, {
              profileId: profile.profileId,
              configurationRevision: profile.configurationRevision,
              configurationFingerprint: profile.configurationFingerprint,
              ...(profile.calibrationId === undefined
                ? {}
                : { calibrationId: profile.calibrationId }),
            })
        }),
      )
    }
    this.assertAuthContext({ userId: user.id, generation })
    return CaptureProfilesViewSchema.parse(
      status === null
        ? this.emptyView()
        : {
            revision: status.revision,
            activeProfileId: status.activeProfileId,
            profiles: status.profiles,
          },
    )
  }

  assertCanChangeProfile(): void {
    this.assertPredictionsStopped()
  }

  async captureSetupCommitted(): Promise<SetupRuntimeOutcome> {
    this.monitor.invalidateCaptureTarget()
    const monitor = await this.monitor.getView()
    if (
      ACTIVE_MONITOR_STATES.includes(
        monitor.state as (typeof ACTIVE_MONITOR_STATES)[number],
      )
    ) {
      const restarted = await this.monitor.restartIfActive()
      if (restarted.state === 'READY') return 'ready'
      if (restarted.state === 'WAITING_SOURCE') return 'waiting_source'
      return 'failed'
    }
    return 'not_requested'
  }

  runCaptureCommit<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      this.assertPredictionsStopped()
      return operation()
    })
  }

  rename(
    profileId: string,
    profileName: string,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    const context = this.requireAuthContext()
    return this.serialized(async () => {
      this.assertAuthContext(context)
      const userId = context.userId
      try {
        await this.repository.rename(
          userId,
          profileId,
          CaptureProfileNameSchema.parse(profileName),
          expectedRevision,
        )
      } catch (error) {
        throw this.publicFailure(error)
      }
      this.assertAuthContext(context)
      return this.result(context)
    })
  }

  duplicate(
    profileId: string,
    profileName: string,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    const context = this.requireAuthContext()
    return this.serialized(async () => {
      this.assertAuthContext(context)
      const userId = context.userId
      const sourceResult = await this.resultRepository?.load(userId, profileId)
      this.assertAuthContext(context)
      const duplicateProfileId = randomUUID()
      try {
        if (sourceResult !== null && sourceResult !== undefined) {
          const { fingerprint: _fingerprint, ...sourceUnsigned } = sourceResult
          void _fingerprint
          const duplicateUnsigned = {
            ...sourceUnsigned,
            captureProfileId: duplicateProfileId,
          }
          await this.resultRepository?.save(
            {
              ...duplicateUnsigned,
              fingerprint: predictionResultFingerprint(duplicateUnsigned),
            },
            duplicateProfileId,
          )
          this.assertAuthContext(context)
        }
        await this.repository.duplicate(
          userId,
          profileId,
          CaptureProfileNameSchema.parse(profileName),
          expectedRevision,
          duplicateProfileId,
        )
      } catch (error) {
        if (sourceResult !== null && sourceResult !== undefined) {
          await this.resultRepository
            ?.delete(userId, duplicateProfileId)
            .catch(() => undefined)
        }
        throw this.publicFailure(error)
      }
      this.assertAuthContext(context)
      return this.result(context)
    })
  }

  activate(
    profileId: string,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    const context = this.requireAuthContext()
    return this.serialized(async () => {
      this.assertAuthContext(context)
      this.assertPredictionsStopped()
      const userId = context.userId
      const current = await this.repository.list(userId)
      const changingProfile = current?.activeProfileId !== profileId
      if (changingProfile) await this.resolveProfile(profileId)
      this.assertAuthContext(context)
      try {
        await this.repository.activate(userId, profileId, expectedRevision)
      } catch (error) {
        throw this.publicFailure(error)
      }
      this.assertAuthContext(context)
      if (changingProfile) {
        this.monitor.invalidateCaptureTarget()
        await this.monitor.restartIfActive()
      }
      return this.result(context)
    })
  }

  delete(
    profileId: string,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    const context = this.requireAuthContext()
    return this.serialized(async () => {
      this.assertAuthContext(context)
      const userId = context.userId
      const current = await this.repository.list(userId)
      if (current === null)
        throw this.publicFailure(new CaptureProfileNotFoundError(profileId))
      const deletingActive = current.activeProfileId === profileId
      if (deletingActive) {
        this.assertPredictionsStopped()
      }
      this.assertAuthContext(context)
      try {
        await this.repository.delete(userId, profileId, expectedRevision)
      } catch (error) {
        throw this.publicFailure(error)
      }
      this.assertAuthContext(context)
      if (deletingActive) {
        this.monitor.invalidateCaptureTarget()
        await this.monitor.stop('profile_deleted')
      }
      await this.resultRepository?.delete(userId, profileId).catch(() => undefined)
      this.assertAuthContext(context)
      return this.result(context)
    })
  }

  rebind(
    profileId: string,
    source: CapturePreference,
    frameSize: PixelSize,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    const context = this.requireAuthContext()
    return this.serialized(async () => {
      this.assertAuthContext(context)
      const userId = context.userId
      const profile = await this.repository.get(userId, profileId)
      if (profile === null)
        throw this.publicFailure(new CaptureProfileNotFoundError(profileId))
      const calibration = profile.configuration.calibration
      const configuredAspect =
        calibration.coordinateSpace === 'game_relative'
          ? null
          : calibration.referenceFrameSize.width / calibration.referenceFrameSize.height
      const nextAspect = frameSize.width / frameSize.height
      if (
        configuredAspect !== null &&
        Math.abs(nextAspect / configuredAspect - 1) > 0.02
      ) {
        throw new ApplicationError(
          'CAPTURE_PROFILE_GEOMETRY_MISMATCH',
          'The selected source has a different aspect ratio; configure its regions',
        )
      }
      const current = await this.repository.list(userId)
      const rebindingActive = current?.activeProfileId === profileId
      if (rebindingActive) this.assertPredictionsStopped()
      this.assertAuthContext(context)
      try {
        await this.repository.rebind(
          userId,
          profileId,
          source,
          expectedRevision,
          frameSize,
        )
      } catch (error) {
        throw this.publicFailure(error)
      }
      this.assertAuthContext(context)
      if (rebindingActive) {
        this.monitor.invalidateCaptureTarget()
        await this.monitor.restartIfActive()
      }
      return this.result(context)
    })
  }

  appendLearnedLayout(
    userId: string,
    profileId: string,
    calibrationId: string,
    layout: GameLayoutWire,
  ): Promise<number> {
    const context = this.requireAuthContext()
    return this.serialized(async () => {
      this.assertAuthContext(context)
      if (context.userId !== userId) {
        throw new ApplicationError(
          'LAYOUT_STALE',
          'The learned layout belongs to another user',
        )
      }
      const { confidence, zonesOrigin, ...fields } = layout
      const geometry = {
        origin: 'auto' as const,
        confidence,
        analyzerVersion: 'm9-geom-1',
      }
      const learned = GameLayoutSchema.parse({
        ...fields,
        provenance: {
          trigger: { ...geometry, analyzerVersion: 'vs-orient-1' },
          nickname:
            zonesOrigin.nickname === 'manual'
              ? { origin: 'manual', confidence: null, analyzerVersion: null }
              : { ...geometry },
          topLeftEvidence:
            zonesOrigin.topLeftEvidence === 'manual'
              ? { origin: 'manual', confidence: null, analyzerVersion: null }
              : { ...geometry },
          viewport: { ...geometry },
        },
      })
      return this.repository.appendLearnedLayout(
        userId,
        profileId,
        calibrationId,
        learned,
      )
    })
  }

  private async result(context: {
    userId: string
    generation: number
  }): Promise<CaptureProfileMutationResult> {
    this.assertAuthContext(context)
    const [configuration, profiles, monitor] = await Promise.all([
      this.repository.load(context.userId),
      this.getView(),
      this.monitor.getView(),
    ])
    this.assertAuthContext(context)
    return {
      profiles,
      monitor,
      capture: CaptureStatusSchema.parse({
        configured: configuration !== null,
        revision: configuration?.revision ?? null,
        sourceLabel: configuration?.sourceBinding.identity.label ?? null,
      }),
    }
  }

  private resolveProfile(profileId: string): Promise<unknown> {
    return this.targetResolver.resolveProfile(profileId).catch((error: unknown) => {
      if (error instanceof ApplicationError) throw error
      throw new ApplicationError(
        'CAPTURE_PROFILE_SOURCE_UNAVAILABLE',
        'The capture profile source is unavailable',
        { cause: error },
      )
    })
  }

  private requireUserId(): string {
    const user = this.auth.getView().user
    if (user === null)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to manage capture profiles')
    return user.id
  }

  private requireAuthContext(): { userId: string; generation: number } {
    return {
      userId: this.requireUserId(),
      generation: this.auth.getContextGeneration(),
    }
  }

  private assertAuthContext(context: { userId: string; generation: number }): void {
    if (
      this.auth.getContextGeneration() !== context.generation ||
      this.auth.getView().user?.id !== context.userId
    ) {
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in session changed during the capture profile operation',
      )
    }
  }

  private assertPredictionsStopped(): void {
    if (['starting', 'active', 'unknown'].includes(this.predictionState())) {
      throw new ApplicationError(
        'PREDICTIONS_ACTIVE',
        'Stop Twitch predictions before changing the capture profile',
      )
    }
  }

  private publicFailure(error: unknown): ApplicationError {
    if (error instanceof ApplicationError) return error
    if (error instanceof CaptureProfileNameConflictError) {
      return new ApplicationError(
        'CAPTURE_PROFILE_NAME_CONFLICT',
        'A capture profile with this name already exists',
      )
    }
    if (error instanceof CaptureProfileLimitError) {
      return new ApplicationError(
        'CAPTURE_PROFILE_LIMIT',
        'The capture profile limit has been reached',
      )
    }
    if (error instanceof CaptureProfileRevisionConflictError) {
      return new ApplicationError(
        'CAPTURE_PROFILE_STALE',
        'Capture profiles changed; refresh and repeat the action',
      )
    }
    if (error instanceof CannotDeleteLastCaptureProfileError) {
      return new ApplicationError(
        'CAPTURE_PROFILE_LAST',
        'The last capture profile cannot be deleted',
      )
    }
    if (error instanceof CaptureProfileNotFoundError) {
      return new ApplicationError(
        'CAPTURE_PROFILE_NOT_FOUND',
        'The selected capture profile no longer exists',
      )
    }
    return new ApplicationError(
      'CAPTURE_PROFILE_OPERATION_FAILED',
      'The capture profile operation failed',
      error instanceof Error ? { cause: error } : undefined,
    )
  }

  private emptyView(): CaptureProfilesView {
    return { revision: null, activeProfileId: null, profiles: [] }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation)
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
