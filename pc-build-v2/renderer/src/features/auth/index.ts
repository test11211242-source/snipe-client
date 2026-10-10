import { useAppData } from '../../app/appData'
import type { AuthController, RoleView } from './useAuthController'

export type { AuthController, RoleView } from './useAuthController'

export function useAuth(): AuthController {
  return useAppData().auth
}

/** Role gate: `isStreamer` is true only when the auth view is loaded and has the role. */
export function useRole(): RoleView {
  return useAppData().role
}
