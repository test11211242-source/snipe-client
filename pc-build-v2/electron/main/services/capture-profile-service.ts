import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  CaptureProfileNameSchema,
  CaptureProfilesViewSchema,
  type CapturePreference,
  type CaptureProfilesView,
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
import type { PredictionResultConfigurationRepository } from '../infrastructure/prediction-result-configuration-repository'
import type { AuthSession } from './auth-session'
import type { CaptureTargetResolver } from './capture-target-resolver'
import type { MonitorSupervisor } from './monitor-supervisor'

const ACTIVE_MONITOR_STATES = ['PREFLIGHT', 'STARTING', 'READY'] as const

export interface CaptureProfileMutationResult {
  profiles: CaptureProfilesView
  monitor: Awaited<ReturnType<MonitorSupervisor['getView']>>
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
    const user = this.auth.getView().user
    if (user === null) return CaptureProfilesViewSchema.parse(this.emptyView())
    const status = await this.repository.list(user.id)
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
    return this.serialized(async () => {
      const userId = this.requireUserId()
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
      return this.result()
    })
  }

  duplicate(
    profileId: string,
    profileName: string,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    return this.serialized(async () => {
      const userId = this.requireUserId()
      const sourceResult = await this.resultRepository?.load(userId, profileId)
      this.assertCurrentUser(userId)
      const duplicateProfileId = randomUUID()
      try {
        if (sourceResult !== null && sourceResult !== undefined) {
          await this.resultRepository?.save(sourceResult, duplicateProfileId)
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
      return this.result()
    })
  }

  activate(
    profileId: string,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    return this.serialized(async () => {
      this.assertPredictionsStopped()
      const userId = this.requireUserId()
      const current = await this.repository.list(userId)
      if (current?.activeProfileId === profileId) return this.result()
      await this.resolveProfile(profileId)
      const monitor = await this.monitor.getView()
      this.assertCurrentUser(userId)
      const restart = ACTIVE_MONITOR_STATES.includes(
        monitor.state as (typeof ACTIVE_MONITOR_STATES)[number],
      )
      try {
        await this.repository.activate(userId, profileId, expectedRevision)
      } catch (error) {
        throw this.publicFailure(error)
      }
      if (restart) {
        await this.monitor.restartIfActive()
      }
      return this.result()
    })
  }

  delete(
    profileId: string,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    return this.serialized(async () => {
      const userId = this.requireUserId()
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
      const monitor = await this.monitor.getView()
      this.assertCurrentUser(userId)
      const restart =
        deletingActive &&
        ACTIVE_MONITOR_STATES.includes(
          monitor.state as (typeof ACTIVE_MONITOR_STATES)[number],
        )
      try {
        await this.repository.delete(userId, profileId, expectedRevision)
        await this.resultRepository?.delete(userId, profileId).catch(() => undefined)
      } catch (error) {
        throw this.publicFailure(error)
      }
      if (restart) {
        await this.monitor.restartIfActive()
      }
      return this.result()
    })
  }

  rebind(
    profileId: string,
    source: CapturePreference,
    frameSize: PixelSize,
    expectedRevision: number,
  ): Promise<CaptureProfileMutationResult> {
    return this.serialized(async () => {
      const userId = this.requireUserId()
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
      const monitor = await this.monitor.getView()
      this.assertCurrentUser(userId)
      const restart =
        rebindingActive &&
        ACTIVE_MONITOR_STATES.includes(
          monitor.state as (typeof ACTIVE_MONITOR_STATES)[number],
        )
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
      if (restart) {
        await this.monitor.restartIfActive()
      }
      return this.result()
    })
  }

  private async result(): Promise<CaptureProfileMutationResult> {
    return { profiles: await this.getView(), monitor: await this.monitor.getView() }
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

  private assertCurrentUser(userId: string): void {
    if (this.auth.getView().user?.id !== userId) {
      throw new ApplicationError(
        'AUTH_CONTEXT_CHANGED',
        'The signed-in user changed during the capture profile operation',
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
