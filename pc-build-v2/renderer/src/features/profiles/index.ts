import { useAppData } from '../../app/appData'
import type { ProfilesController } from './useProfilesController'

export { profileHealth } from './health'
export type { ProfilesController } from './useProfilesController'

export function useProfiles(): ProfilesController {
  return useAppData().profiles
}
