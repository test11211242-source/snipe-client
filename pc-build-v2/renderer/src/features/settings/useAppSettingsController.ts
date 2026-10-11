import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AppSettingsUpdate, AppSettingsView } from '../../../../shared/contracts/app'
import { useResource, type Resource } from '../../app/useResource'

export interface AppSettingsController extends Resource<AppSettingsView> {
  reload: () => Promise<void>
  actionError: string | null
  /**
   * Saves a strict partial patch. Patches are serialized so quick toggles never overwrite
   * each other; on failure the previous good value stays and `actionError` is set.
   */
  update: (patch: AppSettingsUpdate) => Promise<boolean>
}

/** App settings (app:get-settings / app:update-settings) and the reduced-motion attribute. */
export function useAppSettingsController(): AppSettingsController {
  const resource = useResource<AppSettingsView>(
    'settings',
    () => window.crTools.getAppSettings(),
    'Не удалось получить настройки.',
  )
  const { apply, reload: reloadResource, value } = resource
  const [actionError, setActionError] = useState<string | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    const root = document.documentElement
    if (value?.reducedMotion === true) root.dataset['reducedMotion'] = 'true'
    else delete root.dataset['reducedMotion']
  }, [value?.reducedMotion])

  const update = useCallback(
    (patch: AppSettingsUpdate): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        setActionError(null)
        try {
          apply(await window.crTools.updateAppSettings(patch))
          return true
        } catch {
          setActionError('Не удалось сохранить настройку. Прежнее значение осталось.')
          return false
        }
      }
      const result = queue.current.then(run, run)
      queue.current = result
      return result
    },
    [apply],
  )

  const reload = useCallback(() => reloadResource(), [reloadResource])
  return useMemo(
    () => ({ ...resource, reload, actionError, update }),
    [resource, reload, actionError, update],
  )
}
