import { ChatPage } from '../../features/streamer/ChatPage'
import { OverviewPage } from '../../features/streamer/OverviewPage'
import { PredictionsPage } from '../../features/streamer/PredictionsPage'
import { StreamerProvider } from '../../features/streamer/StreamerProvider'
import { useStreamer } from '../../features/streamer/streamerContext'
import { TitlePage } from '../../features/streamer/TitlePage'
import { TwitchPage } from '../../features/streamer/TwitchPage'
import { useFoundations } from '../../features/streamer/useRequirements'
import { WidgetsPage } from '../../features/streamer/WidgetsPage'
import { MAX_STREAMER_ACCOUNTS } from '../../../../shared/models/streamer'
import { Dot } from '../../ui'
import styles from '../../features/streamer/Streamer.module.css'
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

const FOUNDATIONS = ['twitch', 'accounts', 'monitoring', 'zones'] as const
const WITH_CHANNEL: readonly StreamSection[] = ['predictions', 'title', 'chat']
const onOff = (on: boolean): string => (on ? 'включено' : 'выключено')

/** Streamer area: owns the streamer data while open and renders the left navigation. */
export function StreamRoutes({ section }: { section: StreamSection }): React.JSX.Element {
  return (
    <StreamerProvider enabled>
      <Area section={section} />
    </StreamerProvider>
  )
}

function Area({ section }: { section: StreamSection }): React.JSX.Element {
  const { navigate } = useRouter()
  const { view, readiness } = useStreamer()
  const foundations = useFoundations()
  const go = (target: StreamSection) => () =>
    navigate({ name: 'stream', section: target })

  const baseReady = FOUNDATIONS.filter((id) => foundations[id].ok).length
  const connected = view?.twitch.connected
  const widgetsOn =
    view === null
      ? 0
      : Number(view.overlay.settings.opponentEnabled) +
        Number(view.overlay.settings.streamerStatsEnabled)
  const accountsCount = readiness?.accountsCount ?? null

  const groups: NavGroup[] = [
    {
      items: [
        {
          id: 'overview',
          title: 'Обзор',
          sub:
            readiness === null
              ? undefined
              : `${baseReady} из ${FOUNDATIONS.length} основ готово`,
          warn: readiness !== null && baseReady < FOUNDATIONS.length,
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
          sub:
            view === null
              ? undefined
              : connected === true
                ? view.twitch.username === null
                  ? 'подключён'
                  : `@${view.twitch.username}`
                : 'не подключён',
          warn: view !== null && connected !== true,
          icon: 'twitch',
          current: section === 'twitch',
          onSelect: go('twitch'),
        },
        {
          id: 'accounts',
          title: 'Аккаунты Clash Royale',
          sub:
            accountsCount === null
              ? 'в настройках'
              : `${accountsCount} из ${MAX_STREAMER_ACCOUNTS} · в настройках`,
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
          sub:
            view === null
              ? undefined
              : view.predictions.active
                ? 'включены'
                : 'выключены',
          icon: 'trophy',
          current: section === 'predictions',
          onSelect: go('predictions'),
        },
        {
          id: 'title',
          title: 'Название стрима',
          sub: view === null ? undefined : onOff(view.title.settings.enabled),
          icon: 'title',
          current: section === 'title',
          onSelect: go('title'),
        },
        {
          id: 'chat',
          title: 'Колоды в чат',
          sub: view === null ? undefined : onOff(view.deckSharing.enabled),
          icon: 'chat',
          current: section === 'chat',
          onSelect: go('chat'),
        },
        {
          id: 'widgets',
          title: 'Виджеты для OBS',
          sub: view === null ? undefined : `${widgetsOn} из 2 включено`,
          icon: 'layers',
          current: section === 'widgets',
          onSelect: go('widgets'),
        },
      ],
    },
  ]

  const channel =
    view !== null && WITH_CHANNEL.includes(section) ? (
      <button className={styles['channel']} onClick={go('twitch')} type="button">
        <Dot tone={connected === true ? 'ok' : 'warn'} />
        {connected === true
          ? view.twitch.username === null
            ? 'Канал подключён'
            : `@${view.twitch.username}`
          : 'Twitch не подключён'}
      </button>
    ) : undefined

  return (
    <SplitLayout
      groups={groups}
      headTrail={channel}
      navLabel="Разделы стрима"
      title={TITLES[section]}
    >
      {section === 'overview' ? (
        <OverviewPage />
      ) : section === 'twitch' ? (
        <TwitchPage />
      ) : section === 'predictions' ? (
        <PredictionsPage />
      ) : section === 'title' ? (
        <TitlePage />
      ) : section === 'chat' ? (
        <ChatPage />
      ) : (
        <WidgetsPage />
      )}
    </SplitLayout>
  )
}
