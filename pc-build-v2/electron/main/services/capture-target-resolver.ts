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

export class CaptureTargetResolver {
  constructor(
    private readonly auth: AuthSession,
    private readonly repository: CaptureConfigurationRepository,
    private readonly registry: CaptureSourceRegistry,
  ) {}

  async resolve(): Promise<ResolvedMonitorTarget> {
    const user = this.auth.getView().user
    if (user === null)
      throw new ApplicationError('AUTH_REQUIRED', 'Sign in to start monitoring')
    const configuration = await this.repository.load(user.id)
    if (configuration === null) {
      throw new ApplicationError(
        'CAPTURE_NOT_CONFIGURED',
        'Configure capture regions before starting the monitor',
      )
    }
    return {
      configuration,
      selector: await this.registry.resolvePreference(configuration.source),
    }
  }
}
