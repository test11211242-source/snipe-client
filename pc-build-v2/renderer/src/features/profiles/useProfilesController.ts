import { useCallback, useMemo, useState } from 'react'

import type { CaptureProfilesView } from '../../../../shared/models/capture'
import type { MonitorView } from '../../../../shared/models/monitor'
import { useResource, type Resource } from '../../app/useResource'

export interface ProfilesController extends Resource<CaptureProfilesView> {
  reload: () => Promise<void>
  /** Activating, renaming… in flight. */
  pending: boolean
  actionError: string | null
  clearActionError: () => void
  /** Makes a profile active (collection-revision fenced). */
  activate: (profileId: string) => Promise<boolean>
}

/**
 * Capture profile list. Profile commands return the whole new view plus a fresh monitor
 * view; the monitor part is forwarded to `onMonitor` so both stay consistent.
 * M4 adds rename/duplicate/delete/rebind here with the same pattern.
 */
export function useProfilesController(
  onMonitor: (view: MonitorView) => void,
): ProfilesController {
  const resource = useResource<CaptureProfilesView>(
    'profiles',
    () => window.crTools.getCaptureProfiles(),
    'Не удалось получить список профилей.',
  )
  const { apply, reload: reloadResource, value } = resource
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const activate = useCallback(
    async (profileId: string): Promise<boolean> => {
      const revision = value?.revision ?? null
      if (revision === null) return false
      setPending(true)
      setActionError(null)
      try {
        const result = await window.crTools.activateCaptureProfile({
          profileId,
          expectedRevision: revision,
        })
        apply(result.profiles)
        onMonitor(result.monitor)
        return true
      } catch {
        setActionError('Не удалось переключить профиль. Список обновлён.')
        void reloadResource({ quiet: true })
        return false
      } finally {
        setPending(false)
      }
    },
    [apply, onMonitor, reloadResource, value],
  )

  const reload = useCallback(() => reloadResource(), [reloadResource])
  const clearActionError = useCallback(() => setActionError(null), [])

  return useMemo(
    () => ({ ...resource, reload, pending, actionError, clearActionError, activate }),
    [resource, reload, pending, actionError, clearActionError, activate],
  )
}
