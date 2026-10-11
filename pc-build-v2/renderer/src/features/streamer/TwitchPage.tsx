import { useRouter, type StreamSection } from '../../app/router'
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  DialogNotes,
  Group,
  Icon,
  Pill,
  Row,
  Spinner,
  cx,
  type IconName,
  type Tone,
} from '../../ui'
import { StreamerGate } from './StreamerGate'
import { useConfirmedAction, useRunner } from './useRunner'
import { useStreamer } from './streamerContext'
import styles from './Streamer.module.css'

interface Usage {
  section: StreamSection
  icon: IconName
  title: string
  sub: string
  on: boolean
}

/** The one home of the Twitch connection: connect, disconnect and who depends on it. */
export function TwitchPage(): React.JSX.Element {
  return (
    <StreamerGate>
      <Twitch />
    </StreamerGate>
  )
}

function Twitch(): React.JSX.Element {
  const { view, pendingKeys } = useStreamer()
  const { navigate } = useRouter()
  const { run, error } = useRunner()
  const disconnect = useConfirmedAction({ action: 'twitch.disconnect', confirmed: true })
  if (view === null) return <></>

  const { connected, polling, username } = view.twitch
  const connecting = pendingKeys.has('twitch.connect')
  const waiting = polling && !connected
  const usages: Usage[] = [
    {
      section: 'predictions',
      icon: 'trophy',
      title: 'Прогнозы',
      sub: 'Создаются на вашем канале сами',
      on: view.predictions.active,
    },
    {
      section: 'title',
      icon: 'title',
      title: 'Название стрима',
      sub: 'Название трансляции обновляется само',
      on: view.title.settings.enabled,
    },
    {
      section: 'chat',
      icon: 'chat',
      title: 'Колоды в чат',
      sub: 'Колода соперника уходит в чат канала',
      on: view.deckSharing.enabled,
    },
  ]

  return (
    <div className={styles['page']}>
      {error === null ? null : (
        <Banner icon="alert" title="Не получилось" tone="danger">
          {error}
        </Banner>
      )}
      {connected ? (
        <div className={cx(styles['connect'], styles['connectOk'])}>
          <span className={styles['connectIcon']}>
            <Icon name="twitch" size={22} />
          </span>
          <div className={styles['connectText']}>
            <b>{username === null ? 'Канал подключён' : `@${username}`}</b>
            <span>Канал подключён. Одно подключение для всех функций ниже.</span>
          </div>
          <Button onClick={disconnect.ask} variant="danger">
            Отключить
          </Button>
        </div>
      ) : waiting ? (
        <div className={styles['connect']}>
          <span className={styles['connectIcon']}>
            <Spinner label="Ждём подтверждения" />
          </span>
          <div className={styles['connectText']}>
            <b>Ждём подтверждения в браузере</b>
            <span>
              Войдите в Twitch и разрешите доступ в открывшемся окне браузера. Эта
              страница обновится сама.
            </span>
          </div>
          <Button
            loading={connecting}
            onClick={() =>
              void run({ action: 'twitch.connect' }, { key: 'twitch.connect' })
            }
          >
            Открыть браузер снова
          </Button>
        </div>
      ) : (
        <div className={styles['connect']}>
          <span className={styles['connectIcon']}>
            <Icon name="twitch" size={22} />
          </span>
          <div className={styles['connectText']}>
            <b>Twitch не подключён</b>
            <span>
              Откроется браузер: войдите в Twitch и разрешите доступ. Если канал был
              привязан к другому профилю CR Tools, привязка перейдёт сюда.
            </span>
          </div>
          <Button
            loading={connecting}
            onClick={() =>
              void run({ action: 'twitch.connect' }, { key: 'twitch.connect' })
            }
            size="lg"
            variant="primary"
          >
            Подключить Twitch
          </Button>
        </div>
      )}

      <Group title="Где используется">
        <Card flush>
          {usages.map((usage) => {
            const tone: Tone = !connected ? 'warn' : usage.on ? 'ok' : 'neutral'
            const label = !connected
              ? 'Ждёт подключения'
              : usage.on
                ? 'Работает'
                : 'Выключено'
            return (
              <Row
                bordered
                className={styles['rowPad']}
                key={usage.section}
                lead={<Icon name={usage.icon} size={17} />}
                onClick={() => navigate({ name: 'stream', section: usage.section })}
                sub={usage.sub}
                title={usage.title}
                trail={
                  <span className={styles['fnTrail']}>
                    <Pill tone={tone}>{label}</Pill>
                    <span className={styles['fnLabel']}>
                      Открыть
                      <Icon name="chevronRight" size={13} />
                    </span>
                  </span>
                }
              />
            )
          })}
          <Row
            bordered
            className={styles['rowPad']}
            lead={<Icon name="layers" size={17} />}
            onClick={() => navigate({ name: 'stream', section: 'widgets' })}
            sub="Twitch не нужен: своя ссылка с ключом"
            title="Виджеты для OBS"
            trail={
              <span className={styles['fnTrail']}>
                <Pill>Без Twitch</Pill>
                <span className={styles['fnLabel']}>
                  Открыть
                  <Icon name="chevronRight" size={13} />
                </span>
              </span>
            }
          />
        </Card>
      </Group>
      {connected ? (
        <p className={styles['note']}>
          Если отключить Twitch: прогнозы, название и колоды в чат остановятся. Виджеты
          для OBS продолжат работать.
        </p>
      ) : null}

      {disconnect.open ? (
        <ConfirmDialog
          confirmLabel="Отключить Twitch"
          error={disconnect.error}
          onCancel={disconnect.cancel}
          onConfirm={disconnect.confirm}
          pending={disconnect.pending}
          text="Канал будет отключён от CR Tools. Вы сможете подключить его снова в любой момент."
          title="Отключить Twitch?"
        >
          <DialogNotes
            items={[
              'Прогнозы остановятся и не будут создаваться.',
              'Название стрима перестанет обновляться.',
              'Колоды перестанут отправляться в чат.',
              'Виджеты для OBS продолжат работать.',
            ]}
          />
        </ConfirmDialog>
      ) : null}
    </div>
  )
}
