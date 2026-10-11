import { useAppData } from '../../app/appData'
import type { MonitorController } from './useMonitorController'

export { formatElapsed, selectRunPhase, selectStatus } from './selectors'
export type { MonitorStatusPresentation, RunPhase } from './selectors'
export type { MonitorController } from './useMonitorController'

/** The single monitor controller of the main window (value, start/stop, retry). */
export function useMonitorView(): MonitorController {
  return useAppData().monitor
}
