import { useCallback, useEffect, useMemo, useState } from 'react'

import type { MonitorView } from '../../../../shared/models/monitor'
import { usePolling, useResource, type Resource } from '../../app/useResource'

export interface MonitorController extends Resource<MonitorView> {
  /** Start requested and not yet answered. */
  starting: boolean
  stopping: boolean
  /** Last failed Start/Stop/retry in Russian, or null. */
  actionError: string | null
  clearActionError: () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  retrySearch: (attemptId: string) => Promise<void>
  reload: () => Promise<void>
  /** Applies a MonitorView returned by another command (profile activation). */
  apply: (view: MonitorView) => void
}

/**
 * Owns the single monitor subscription of the main window.
 * Monitoring itself belongs to main: nothing here starts or stops it on mount, route
 * change or unmount — only the explicit start()/stop() commands do.
 */
export function useMonitorController(): MonitorController {
  const resource = useResource<MonitorView>(
    'monitor',
    () => window.crTools.getMonitorView(),
    'Не удалось получить состояние мониторинга.',
  )
  const { apply, reload: reloadResource } = resource
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Subscribe once; main pushes every state/progress change.
  useEffect(() => window.crTools.onMonitorViewChanged(apply), [apply])

  // Slow safety reconciliation for missed events.
  usePolling(
    () => void reloadResource({ quiet: true }),
    () => (document.hidden ? 30_000 : 10_000),
  )

  const run = useCallback(
    async (
      command: () => Promise<MonitorView>,
      pending: (value: boolean) => void,
      failure: string,
    ): Promise<void> => {
      pending(true)
      setActionError(null)
      try {
        apply(await command())
      } catch {
        setActionError(failure)
        // The view may have changed even though the command failed.
        void reloadResource({ quiet: true })
      } finally {
        pending(false)
      }
    },
    [apply, reloadResource],
  )

  const start = useCallback(
    () =>
      run(
        () => window.crTools.startMonitor(),
        setStarting,
        'Не удалось начать мониторинг. Повторите попытку.',
      ),
    [run],
  )
  const stop = useCallback(
    () =>
      run(
        () => window.crTools.stopMonitor(),
        setStopping,
        'Не удалось остановить мониторинг. Повторите попытку.',
      ),
    [run],
  )
  const retrySearch = useCallback(
    (attemptId: string) =>
      run(
        () => window.crTools.retryMonitorSearch({ attemptId }),
        () => undefined,
        'Не удалось повторить поиск. Дождитесь следующего боя.',
      ),
    [run],
  )
  const reload = useCallback(() => reloadResource(), [reloadResource])
  const clearActionError = useCallback(() => setActionError(null), [])

  return useMemo(
    () => ({
      ...resource,
      reload,
      starting,
      stopping,
      actionError,
      clearActionError,
      start,
      stop,
      retrySearch,
    }),
    [
      resource,
      reload,
      starting,
      stopping,
      actionError,
      clearActionError,
      start,
      stop,
      retrySearch,
    ],
  )
}
