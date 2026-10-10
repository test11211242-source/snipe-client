import { Placeholder } from './Placeholder'
import { SplitLayout, type NavGroup } from '../shell/SplitLayout'
import { useAppData } from '../appData'
import { useRouter, type SettingsSection } from '../router'

const TITLES: Record<SettingsSection, string> = {
  app: 'Приложение',
  overlay: 'Оверлей соперника',
  accounts: 'Аккаунты Clash Royale',
  updates: 'Обновления',
}

/** Settings area: left navigation. Section pages are M5. */
export function SettingsRoutes({
  section,
}: {
  section: SettingsSection
}): React.JSX.Element {
  const { navigate } = useRouter()
  const { snapshot } = useAppData()
  const item = (
    id: SettingsSection,
    icon: 'sliders' | 'window' | 'users' | 'download',
    sub?: string,
  ): NavGroup['items'][number] => ({
    id,
    title: TITLES[id],
    sub,
    icon,
    current: section === id,
    onSelect: () => navigate({ name: 'settings', section: id }),
  })
  const groups: NavGroup[] = [
    {
      items: [
        item('app', 'sliders', 'запуск, трей, журнал'),
        item('overlay', 'window', 'колоды'),
        item('accounts', 'users'),
        item(
          'updates',
          'download',
          snapshot.value === null ? undefined : `версия ${snapshot.value.version}`,
        ),
      ],
    },
  ]
  return (
    <SplitLayout groups={groups} navLabel="Разделы настроек" title={TITLES[section]}>
      <Placeholder
        icon="gear"
        legacy="settings"
        legacyLabel="Открыть прежние настройки"
        text="Этот раздел переносится в новый интерфейс. Пока настройки доступны в прежнем экране."
        title={TITLES[section]}
      />
    </SplitLayout>
  )
}
