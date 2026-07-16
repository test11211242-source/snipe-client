import {
  LogoutRequestSchema,
  ServerLogoutResponseSchema,
} from '../../../shared/contracts/server'
import { ApplicationError } from '../../../shared/errors/application-error'
import type { ApiClient } from './api-client'
import type { AuthSessionRevoker } from './auth-session'

export class ApiAuthSessionRevoker implements AuthSessionRevoker {
  constructor(private readonly api: Pick<ApiClient, 'request'>) {}

  async revoke(refreshToken: string): Promise<void> {
    const result = await this.api.request({
      method: 'POST',
      path: '/api/auth/logout',
      body: LogoutRequestSchema.parse({ refresh_token: refreshToken }),
      schema: ServerLogoutResponseSchema,
    })
    if (!result.ok) {
      throw new ApplicationError(result.error.code, result.error.message)
    }
  }
}
