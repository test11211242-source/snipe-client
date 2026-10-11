import { useAppData } from '../../app/appData'
import type { UpdaterController } from './useUpdaterController'

export type { UpdaterController } from './useUpdaterController'

export function useUpdater(): UpdaterController {
  return useAppData().update
}
