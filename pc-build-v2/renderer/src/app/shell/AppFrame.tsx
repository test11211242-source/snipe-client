import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useAuth } from '../../features/auth'
import { ProfilesPanel } from '../../features/profiles/ProfilesPanel'
import { TagPalette } from '../../features/palette/TagPalette'
import { Banner, Button, Dot } from '../../ui'
import { useAppData } from '../appData'
import { TierProvider, useContainerTier } from '../useTier'
import { AccountMenu } from './AccountMenu'
import { CommandBar } from './CommandBar'
import styles from './Frame.module.css'
import { ShellSlotsProvider } from './ShellSlots'
import { ShellActionsContext, useShellSlots } from './slotsContext'
import { Titlebar } from './Titlebar'
import { UpdateHost } from './UpdateHost'

function Notices(): React.JSX.Element | null {
  const { failures } = useAppData()
  if (failures.length === 0) return null
  return (
    <div className={styles['notices']}>
      {failures.map((failure) => (
        <Banner
          actions={
            <Button onClick={failure.retry} size="sm">
              Повторить
            </Button>
          }
          icon="alert"
          key={failure.name}
          title={`Не загрузилось: ${failure.label}`}
          tone="warn"
        >
          Остальное приложение работает.
        </Banner>
      ))}
    </div>
  )
}

function StatusBar({ mini }: { mini: boolean }): React.JSX.Element {
  const { snapshot, realtime, settings } = useAppData()
  const offline =
    realtime.value !== null &&
    realtime.value.desiredConnected &&
    (realtime.value.state === 'BACKOFF' || realtime.value.state === 'DISCONNECTED')
  const closeToTray = settings.value?.closeToTray
  return (
    <footer className={styles['statusbar']}>
      <span>
        <Dot tone={offline ? 'warn' : 'ok'} />
        {offline ? 'Переподключение…' : 'Связь с сервером'}
        {snapshot.value === null ? '' : ` · v${snapshot.value.version}`}
      </span>
      {mini || closeToTray === undefined ? null : (
        <span>
          {closeToTray
            ? 'Закрытие окна сворачивает в трей, мониторинг продолжается'
            : 'Закрытие окна завершает приложение'}
        </span>
      )}
    </footer>
  )
}

function MiniStrip(): React.JSX.Element | null {
  const auth = useAuth()
  const { setMiniStripExtra } = useShellSlots()
  const user = auth.value?.user
  if (user === undefined || user === null) return null
  return (
    <div className={styles['miniStrip']}>
      <AccountMenu direction="up" showModes />
      <div className={styles['miniStripText']}>
        <b>{user.username}</b>
        <span>{user.email}</span>
      </div>
      <div className={styles['miniExtra']} ref={setMiniStripExtra} />
    </div>
  )
}

/**
 * Main window frame: titlebar, global update strip, command bar, partial-bootstrap
 * notices, page content, mini account strip and status bar. `chrome="none"` (setup)
 * keeps only the titlebar.
 */
export function AppFrame({
  children,
  chrome = 'full',
}: {
  children: ReactNode
  chrome?: 'full' | 'none'
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const tier = useContainerTier(ref)
  const [palette, setPalette] = useState(false)
  const [panel, setPanel] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const actions = useMemo(
    () => ({ openProfiles: () => setPanel(true), openPalette: () => setPalette(true) }),
    [],
  )

  return (
    <TierProvider value={tier}>
      <ShellSlotsProvider>
        <ShellActionsContext.Provider value={actions}>
          <div className={styles['frame']} ref={ref}>
            <Titlebar />
            {chrome === 'full' ? (
              <>
                <UpdateHost />
                <CommandBar
                  onManageProfiles={() => setPanel(true)}
                  onOpenPalette={() => setPalette(true)}
                />
                <Notices />
              </>
            ) : null}
            <main className={styles['content']}>{children}</main>
            {chrome === 'full' && tier === 'mini' ? <MiniStrip /> : null}
            {chrome === 'full' ? <StatusBar mini={tier === 'mini'} /> : null}
            {palette ? <TagPalette onClose={() => setPalette(false)} /> : null}
            {panel ? <ProfilesPanel onClose={() => setPanel(false)} /> : null}
          </div>
        </ShellActionsContext.Provider>
      </ShellSlotsProvider>
    </TierProvider>
  )
}
