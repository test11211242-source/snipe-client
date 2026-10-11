import { createContext, useContext } from 'react'

import type { HelloResult } from '../../../shared/contracts/app'
import type { AppSnapshot } from '../../../shared/models/application'
import type { RealtimeStatus } from '../../../shared/models/network'
import type { AuthController, RoleView } from '../features/auth/useAuthController'
import type { MonitorController } from '../features/monitor/useMonitorController'
import type { ProfilesController } from '../features/profiles/useProfilesController'
import type { AppSettingsController } from '../features/settings/useAppSettingsController'
import type { UpdaterController } from '../features/updates/useUpdaterController'
import type { Resource, ResourceName } from './useResource'

export interface FailedResource {
  name: ResourceName
  /** Russian name of what failed, for "Не загрузились: …". */
  label: string
  retry: () => void
}

export interface AppData {
  auth: AuthController
  role: RoleView
  monitor: MonitorController
  profiles: ProfilesController
  settings: AppSettingsController
  update: UpdaterController
  realtime: Resource<RealtimeStatus>
  snapshot: Resource<AppSnapshot>
  protocol: Resource<HelloResult>
  /** Resources whose latest load failed; each keeps its last good value. */
  failures: readonly FailedResource[]
  retryAll: () => void
}

export const AppDataContext = createContext<AppData | null>(null)

export function useAppData(): AppData {
  const data = useContext(AppDataContext)
  if (data === null) throw new Error('useAppData must be used inside AppDataProvider')
  return data
}
