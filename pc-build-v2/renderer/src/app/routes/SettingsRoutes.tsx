import { MAX_STREAMER_ACCOUNTS } from '../../../../shared/models/streamer'
import { AccountsPage } from '../../features/settings/AccountsPage'
import { AppSettingsPage } from '../../features/settings/AppSettingsPage'
import { OverlaySettingsPage } from '../../features/settings/OverlaySettingsPage'
import { UpdatesPage } from '../../features/settings/UpdatesPage'
import { StreamerProvider } from '../../features/streamer/StreamerProvider'
import { useStreamer } from '../../features/streamer/streamerContext'
import { useUpdater } from '../../features/updates'
import { useAppData } from '../appData'
import { SplitLayout, type NavGroup } from '../shell/SplitLayout'
import { useRouter, type SettingsSection } from '../router'

const TITLES: Record<SettingsSection, string> = {
  app: 'Приложение',
  overlay: 'Оверлей соперника',
  accounts: 'Аккаунты Clash Royale',
  updates: 'Обновления',
}

/** Settings area. Streamers get their account list loaded for the navigation count. */
export function SettingsRoutes({
  section,
}: {
  section: SettingsSection
}): React.JSX.Element {
  const { role } = useAppData()
  return (
    <StreamerProvider enabled={role.isStreamer}>
      <Area section={section} />
    </StreamerProvider>
  )
}

function Area({ section }: { section: SettingsSection }): React.JSX.Element {
  const { navigate } = useRouter()
  const { snapshot, role } = useAppData()
  const updater = useUpdater()
  const { readiness } = useStreamer()
  const update = updater.value
  const item = (
    id: SettingsSection,
    icon: 'sliders' | 'window' | 'users' | 'download',
    sub?: string,
    warn = false,
  ): NavGroup['items'][number] => ({
    id,
    title: TITLES[id],
    sub,
    warn,
    icon,
    current: section === id,
    onSelect: () => navigate({ name: 'settings', section: id }),
  })
  const accountsSub = !role.isStreamer
    ? 'только для стримеров'
    : readiness?.accountsCount == null
      ? undefined
      : `${readiness.accountsCount} из ${MAX_STREAMER_ACCOUNTS}`
  const updatesSub =
    update?.availableVersion != null &&
    (update.state === 'AVAILABLE' ||
      update.state === 'READY' ||
      update.state === 'DOWNLOADING')
      ? `доступна ${update.availableVersion}`
      : snapshot.value === null
        ? undefined
        : `версия ${snapshot.value.version}`
  const groups: NavGroup[] = [
    {
      items: [
        item('app', 'sliders', 'запуск, трей, журнал'),
        item('overlay', 'window', 'окно поверх игры'),
        item('accounts', 'users', accountsSub),
        item(
          'updates',
          'download',
          updatesSub,
          update?.state === 'AVAILABLE' || update?.state === 'READY',
        ),
      ],
    },
  ]
  return (
    <SplitLayout groups={groups} navLabel="Разделы настроек" title={TITLES[section]}>
      {section === 'app' ? (
        <AppSettingsPage />
      ) : section === 'overlay' ? (
        <OverlaySettingsPage />
      ) : section === 'accounts' ? (
        <AccountsPage />
      ) : (
        <UpdatesPage />
      )}
    </SplitLayout>
  )
}
