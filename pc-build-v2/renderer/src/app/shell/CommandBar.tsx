import { useEffect, useState } from 'react'

import { useRole } from '../../features/auth'
import {
  formatElapsed,
  selectRunPhase,
  selectStatus,
  useMonitorView,
} from '../../features/monitor'
import { useProfiles } from '../../features/profiles'
import { Banner, Dot, IconButton, Icon, Kbd, RunButton, Spinner, cx } from '../../ui'
import { useAppData } from '../appData'
import { useRouter } from '../router'
import { useTier } from '../useTier'
import { AccountMenu } from './AccountMenu'
import styles from './CommandBar.module.css'
import { ProfileSwitcher } from './ProfileSwitcher'

/** Elapsed monitoring time; owns its own timer so the rest of the page does not re-render. */
function Elapsed({ since }: { since: string | null }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  if (since === null) return null
  return <span className={styles['time']}>{formatElapsed(now - Date.parse(since))}</span>
}

function Status(): React.JSX.Element {
  const monitor = useMonitorView()
  const profiles = useProfiles()
  const { realtime } = useAppData()
  const hasProfiles = (profiles.value?.profiles.length ?? 0) > 0
  const status = selectStatus(monitor.value, hasProfiles, realtime.value)
  const tone =
    status.tone === 'warn'
      ? styles['statusWarn']
      : status.tone === 'danger'
        ? styles['statusDanger']
        : ''
  return (
    <div aria-live="polite" className={cx(styles['status'], tone)}>
      {status.busy ? <Spinner /> : <Dot live={status.live} tone={status.tone} />}
      <span className={styles['statusText']}>{status.text}</span>
      {status.showElapsed ? <Elapsed since={monitor.value?.startedAt ?? null} /> : null}
    </div>
  )
}

/**
 * Command bar of every app page: profile switcher, status, tag search, Start/Stop,
 * Игра/Стрим (streamer only), settings and avatar menu.
 */
export function CommandBar({
  onOpenPalette,
  onManageProfiles,
}: {
  onOpenPalette: () => void
  onManageProfiles: () => void
}): React.JSX.Element {
  const tier = useTier()
  const mini = tier === 'mini'
  const { route, navigate } = useRouter()
  const role = useRole()
  const monitor = useMonitorView()
  const profiles = useProfiles()
  const { realtime } = useAppData()
  const hasProfiles = (profiles.value?.profiles.length ?? 0) > 0
  const phase = selectRunPhase(monitor.value, hasProfiles)
  const stream = route.name === 'stream'
  const onSettings = route.name === 'settings'
  const reconnecting =
    realtime.value !== null &&
    realtime.value.desiredConnected &&
    (realtime.value.state === 'BACKOFF' || realtime.value.state === 'DISCONNECTED') &&
    phase === 'running'

  let runButton: React.JSX.Element
  if (phase === 'no-profile')
    runButton = (
      <RunButton
        compact={mini}
        label="Создать профиль"
        onClick={() => navigate({ name: 'setup' })}
      >
        <Icon name="plus" size={16} />
      </RunButton>
    )
  else if (phase === 'starting' || phase === 'stopping')
    runButton = (
      <RunButton
        compact={mini}
        disabled
        label={phase === 'starting' ? 'Запускаем…' : 'Останавливаем…'}
        loading
      />
    )
  else if (phase === 'running' || phase === 'waiting-source')
    runButton = (
      <RunButton
        compact={mini}
        label="Остановить"
        loading={monitor.stopping}
        onClick={() => void monitor.stop()}
        running
      >
        <Icon name="stop" size={15} />
      </RunButton>
    )
  else
    runButton = (
      <RunButton
        compact={mini}
        label="Начать мониторинг"
        loading={monitor.starting}
        onClick={() => void monitor.start()}
      >
        <Icon name="play" size={15} />
      </RunButton>
    )

  return (
    <>
      <nav
        aria-label="Главная панель"
        className={cx(
          styles['bar'],
          mini && styles['mini'],
          tier === 'medium' && styles['medium'],
        )}
      >
        <ProfileSwitcher flex={mini} onManage={onManageProfiles} />
        {mini ? null : <Status />}
        {mini ? null : <span className={styles['spacer']} />}
        {mini || tier === 'medium' ? (
          <IconButton label="Проверить тег (Ctrl+K)" onClick={onOpenPalette}>
            <Icon name="search" size={17} />
          </IconButton>
        ) : (
          <button
            className={styles['search']}
            onClick={onOpenPalette}
            title="Проверить тег соперника (Ctrl+K)"
            type="button"
          >
            <Icon name="search" size={15} />
            <span>Проверить тег</span>
            <Kbd>Ctrl K</Kbd>
          </button>
        )}
        {runButton}
        {role.isStreamer && !mini ? (
          <div aria-label="Раздел" className={styles['modes']} role="group">
            <button
              aria-current={!stream ? 'page' : undefined}
              aria-label="Игра"
              className={styles['mode']}
              onClick={() => navigate({ name: 'main' })}
              type="button"
            >
              <Icon name="target" size={15} />
              {tier === 'wide' ? <span>Игра</span> : null}
            </button>
            <button
              aria-current={stream ? 'page' : undefined}
              aria-label="Стрим"
              className={styles['mode']}
              onClick={() => navigate({ name: 'stream', section: 'overview' })}
              type="button"
            >
              <Icon name="broadcast" size={15} />
              {tier === 'wide' ? <span>Стрим</span> : null}
            </button>
          </div>
        ) : null}
        <IconButton
          active={onSettings}
          label="Настройки"
          onClick={() => navigate({ name: 'settings', section: 'app' })}
        >
          <Icon name="gear" size={18} />
        </IconButton>
        {mini ? null : <AccountMenu />}
      </nav>
      {mini && route.name !== 'main' ? (
        <div className={styles['reconnect']}>
          <Status />
        </div>
      ) : null}
      {reconnecting ? (
        <div className={styles['reconnect']}>
          <Banner
            actions={<Spinner />}
            icon="wifiOff"
            title="Нет связи с сервером. Переподключаемся…"
            tone="warn"
          >
            {`Попытка ${realtime.value?.reconnectAttempt ?? 0}. Найденные соперники появятся после переподключения.`}
          </Banner>
        </div>
      ) : null}
      {monitor.actionError === null ? null : (
        <div className={styles['reconnect']}>
          <Banner
            actions={
              <IconButton
                label="Скрыть сообщение"
                onClick={monitor.clearActionError}
                size="sm"
              >
                <Icon name="close" size={14} />
              </IconButton>
            }
            icon="alert"
            title={monitor.actionError}
            tone="danger"
          />
        </div>
      )}
    </>
  )
}
