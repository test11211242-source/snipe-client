import { ApplicationError } from '../../../shared/errors/application-error'
import type { CaptureConfiguration } from '../../../shared/models/capture'
import type { SetupCaptureSelector } from '../domain/capture-source'
import type { CaptureConfigurationRepository } from '../infrastructure/capture-configuration-repository'
import type { AuthSession } from './auth-session'
import type { CaptureSourceRegistry } from './capture-source-registry'

export interface ResolvedMonitorTarget {
  configuration: CaptureConfiguration
  selector: SetupCaptureSelector
}

export interface ResolvedActiveCaptureProfile extends ResolvedMonitorTarget {
  userId: string
  profileId: string
  profileName: string
  collectionRevision: number
}

export class CaptureTargetResolver {
  constructor(
    private readonly auth: AuthSession,
    private readonly repository: CaptureConfigurationRepository,
    private readonly registry: CaptureSourceRegistry,
  ) {}

  async resolve(): Promise<ResolvedMonitorTarget> {
    const active = await this.resolveActiveProfile()
    return { configuration: active.configuration, selector: active.selector }
  }

  async resolveActiveProfile(): Promise<ResolvedActiveCaptureProfile> {
    const user = this.auth.getView().user
    if (user === null)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to start monitoring')
    const active = await this.repository.getActive(user.id)
    if (active === null) {
      throw new ApplicationError(
        'CAPTURE_NOT_CONFIGURED',
        'Configure capture regions before starting the monitor',
      )
    }
    return {
      userId: user.id,
      profileId: active.profile.profileId,
      profileName: active.profile.profileName,
      collectionRevision: active.collectionRevision,
      configuration: active.profile.configuration,
      selector: await this.registry.resolvePreference(
        active.profile.configuration.source,
      ),
    }
  }

  async resolveProfile(profileId: string): Promise<ResolvedMonitorTarget> {
    const user = this.auth.getView().user
    if (user === null)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to select a capture profile')
    const profile = await this.repository.get(user.id, profileId)
    if (profile === null) {
      throw new ApplicationError(
        'CAPTURE_PROFILE_NOT_FOUND',
        'The selected capture profile no longer exists',
      )
    }
    return {
      configuration: profile.configuration,
      selector: await this.registry.resolvePreference(profile.configuration.source),
    }
  }
}
