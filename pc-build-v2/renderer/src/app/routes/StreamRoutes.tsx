import { useMemo } from 'react'

import { Placeholder } from './Placeholder'
import { SplitLayout, type NavGroup } from '../shell/SplitLayout'
import { useRouter, type StreamSection } from '../router'

const TITLES: Record<StreamSection, string> = {
  overview: 'Обзор эфира',
  twitch: 'Twitch-канал',
  predictions: 'Прогнозы',
  title: 'Название стрима',
  chat: 'Колоды в чат',
  widgets: 'Виджеты для OBS',
}

/** Streamer area: left navigation. Section pages are M5; status lines are filled there too. */
export function StreamRoutes({ section }: { section: StreamSection }): React.JSX.Element {
  const { navigate, route } = useRouter()
  const go = (target: StreamSection) => () =>
    navigate({ name: 'stream', section: target })
  const groups = useMemo<NavGroup[]>(
    () => [
      {
        items: [
          {
            id: 'overview',
            title: 'Обзор',
            icon: 'grid',
            current: section === 'overview',
            onSelect: go('overview'),
          },
        ],
      },
      {
        title: 'Подключения',
        items: [
          {
            id: 'twitch',
            title: 'Twitch-канал',
            icon: 'twitch',
            current: section === 'twitch',
            onSelect: go('twitch'),
          },
          {
            id: 'accounts',
            title: 'Аккаунты Clash Royale',
            sub: 'в настройках',
            icon: 'users',
            current: false,
            external: true,
            onSelect: () => navigate({ name: 'settings', section: 'accounts' }),
          },
        ],
      },
      {
        title: 'Функции',
        items: [
          {
            id: 'predictions',
            title: 'Прогнозы',
            icon: 'trophy',
            current: section === 'predictions',
            onSelect: go('predictions'),
          },
          {
            id: 'title',
            title: 'Название стрима',
            icon: 'title',
            current: section === 'title',
            onSelect: go('title'),
          },
          {
            id: 'chat',
            title: 'Колоды в чат',
            icon: 'chat',
            current: section === 'chat',
            onSelect: go('chat'),
          },
          {
            id: 'widgets',
            title: 'Виджеты для OBS',
            icon: 'layers',
            current: section === 'widgets',
            onSelect: go('widgets'),
          },
        ],
      },
    ],
    // go/navigate are stable for a given route; recompute when the section changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section, route],
  )
  return (
    <SplitLayout groups={groups} navLabel="Разделы стрима" title={TITLES[section]}>
      <Placeholder
        icon="broadcast"
        legacy="streamer"
        legacyLabel="Открыть прежний раздел «Стример»"
        text="Этот раздел переносится в новый интерфейс. Пока все функции доступны в прежнем экране."
        title={TITLES[section]}
      />
    </SplitLayout>
  )
}
