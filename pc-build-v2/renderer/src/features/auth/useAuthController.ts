import { useCallback, useMemo, useState } from 'react'

import { hasStreamerRole, type AuthView } from '../../../../shared/models/auth'
import { useResource, type Resource } from '../../app/useResource'

export interface AuthController extends Resource<AuthView> {
  reload: () => Promise<void>
  /** Logout in flight. */
  loggingOut: boolean
  actionError: string | null
  /** Resolves true when main accepted the logout (it then closes this window). */
  logout: () => Promise<boolean>
}

export function useAuthController(): AuthController {
  const resource = useResource<AuthView>(
    'auth',
    () => window.crTools.getAuthView(),
    'Не удалось получить данные учётной записи.',
  )
  const { apply, reload: reloadResource } = resource
  const [loggingOut, setLoggingOut] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const logout = useCallback(async (): Promise<boolean> => {
    setLoggingOut(true)
    setActionError(null)
    try {
      apply(await window.crTools.logout())
      return true
    } catch {
      setActionError('Не удалось выйти из аккаунта. Повторите операцию.')
      return false
    } finally {
      setLoggingOut(false)
    }
  }, [apply])

  const reload = useCallback(() => reloadResource(), [reloadResource])
  return useMemo(
    () => ({ ...resource, reload, loggingOut, actionError, logout }),
    [resource, reload, loggingOut, actionError, logout],
  )
}

export interface RoleView {
  /** Streamer role is certain (auth loaded and contains it). Unknown/loading → false. */
  isStreamer: boolean
  /** Auth is still unknown, so role-gated routes must wait instead of redirecting. */
  pending: boolean
}

export function roleOf(auth: Resource<AuthView>): RoleView {
  return {
    isStreamer: hasStreamerRole(auth.value),
    pending: auth.value === null && auth.error === null,
  }
}
