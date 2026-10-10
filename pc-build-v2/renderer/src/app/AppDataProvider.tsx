import { useCallback, useMemo, type ReactNode } from 'react'

import type { HelloResult } from '../../../shared/contracts/app'
import type { AppSnapshot } from '../../../shared/models/application'
import type { RealtimeStatus } from '../../../shared/models/network'
import { roleOf, useAuthController } from '../features/auth/useAuthController'
import { useMonitorController } from '../features/monitor/useMonitorController'
import { useProfilesController } from '../features/profiles/useProfilesController'
import { useAppSettingsController } from '../features/settings/useAppSettingsController'
import { useUpdaterController } from '../features/updates/useUpdaterController'
import { AppDataContext, type AppData } from './appData'
import { usePolling, useResource, type ResourceName } from './useResource'

const LABELS: Partial<Record<ResourceName, string>> = {
  protocol: 'совместимость приложения',
  snapshot: 'версия приложения',
  auth: 'учётная запись',
  realtime: 'связь с сервером',
  profiles: 'профили',
  monitor: 'мониторинг',
  settings: 'настройки',
  update: 'обновления',
}

/**
 * Creates every controller exactly once for the main window. Resources load
 * independently: one failing resource shows its own error and the others stay usable.
 */
export function AppDataProvider({
  children,
}: {
  children: ReactNode
}): React.JSX.Element {
  const auth = useAuthController()
  const monitor = useMonitorController()
  const profiles = useProfilesController(monitor.apply)
  const settings = useAppSettingsController()
  const update = useUpdaterController()
  const realtimeResource = useResource<RealtimeStatus>(
    'realtime',
    () => window.crTools.getRealtimeStatus(),
    'Не удалось получить состояние связи.',
  )
  const snapshot = useResource<AppSnapshot>(
    'snapshot',
    () => window.crTools.getAppSnapshot(),
    'Не удалось получить версию приложения.',
  )
  const protocol = useResource<HelloResult>(
    'protocol',
    () => window.crTools.hello(),
    'Не удалось подтвердить совместимость приложения.',
  )
  const reloadRealtime = realtimeResource.reload
  usePolling(
    () => void reloadRealtime({ quiet: true }),
    () => (document.hidden ? 15_000 : 5_000),
  )

  const retryAll = useCallback((): void => {
    void protocol.reload()
    void snapshot.reload()
    void auth.reload()
    void realtimeResource.reload()
    void profiles.reload()
    void monitor.reload()
    void settings.reload()
    void update.reload()
  }, [protocol, snapshot, auth, realtimeResource, profiles, monitor, settings, update])

  const value = useMemo<AppData>(() => {
    const entries = [
      ['protocol', protocol],
      ['snapshot', snapshot],
      ['auth', auth],
      ['realtime', realtimeResource],
      ['profiles', profiles],
      ['monitor', monitor],
      ['settings', settings],
      ['update', update],
    ] as const
    return {
      auth,
      role: roleOf(auth),
      monitor,
      profiles,
      settings,
      update,
      realtime: realtimeResource,
      snapshot,
      protocol,
      failures: entries
        .filter(([, resource]) => resource.error !== null)
        .map(([name, resource]) => ({
          name,
          label: LABELS[name] ?? name,
          retry: () => void resource.reload(),
        })),
      retryAll,
    }
  }, [
    auth,
    monitor,
    profiles,
    settings,
    update,
    realtimeResource,
    snapshot,
    protocol,
    retryAll,
  ])

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
}
