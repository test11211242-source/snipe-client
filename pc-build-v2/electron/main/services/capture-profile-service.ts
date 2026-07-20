import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  CaptureProfileNameSchema,
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

const ACTIVE_MONITOR_STATES = ['PREFLIGHT', 'STARTING', 'READY'] as const

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

  async captureSetupCommitted(): Promise<void> {
    this.monitor.invalidateCaptureTarget()
    const monitor = await this.monitor.getView()
    if (
      ACTIVE_MONITOR_STATES.includes(
        monitor.state as (typeof ACTIVE_MONITOR_STATES)[number],
      )
    ) {
      await this.monitor.restartIfActive()
    }
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
        const replacement = current.profiles.find(
          (profile) => profile.profileId !== profileId,
        )
        if (replacement !== undefined) await this.resolveProfile(replacement.profileId)
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
        await this.monitor.restartIfActive()
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
      const configuredAspect =
        profile.configuration.frameSize.width / profile.configuration.frameSize.height
      const nextAspect = frameSize.width / frameSize.height
      if (Math.abs(nextAspect / configuredAspect - 1) > 0.02) {
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

  private async result(context: {
    userId: string
    generation: number
  }): Promise<CaptureProfileMutationResult> {
    this.assertAuthContext(context)
    const [configuration, status, monitor] = await Promise.all([
      this.repository.load(context.userId),
      this.repository.list(context.userId),
      this.monitor.getView(),
    ])
    this.assertAuthContext(context)
    return {
      profiles: CaptureProfilesViewSchema.parse(
        status === null
          ? this.emptyView()
          : {
              revision: status.revision,
              activeProfileId: status.activeProfileId,
              profiles: status.profiles,
            },
      ),
      monitor,
      capture: CaptureStatusSchema.parse({
        configured: configuration !== null,
        revision: configuration?.revision ?? null,
        sourceLabel: configuration?.source.label ?? null,
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
