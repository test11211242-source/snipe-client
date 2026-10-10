import { useAppData } from '../../app/appData'
import type { AppSettingsController } from './useAppSettingsController'

export type { AppSettingsController } from './useAppSettingsController'

export function useAppSettings(): AppSettingsController {
  return useAppData().settings
}
