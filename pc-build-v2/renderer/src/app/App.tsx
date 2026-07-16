import { Aperture, House, LogOut, Radio, Settings, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import '../styles/global.css'
import '../styles/streamer.css'
import { CapturePage } from './CapturePage'
import { authLabel, realtimeLabel, updateStateLabel } from './format'
import { HomePage } from './HomePage'
import { SettingsPage } from './SettingsPage'
import { StreamerPage } from './StreamerPage'
import { Alert, Button, Status } from './ui'
import { useAppBootstrap } from './useAppBootstrap'

type SectionId = 'home' | 'capture' | 'streamer' | 'settings'

interface NavigationItem {
  id: SectionId
  label: string
  icon: LucideIcon
}

const NAVIGATION: readonly NavigationItem[] = [
  { id: 'home', label: 'Главная', icon: House },
  { id: 'capture', label: 'Захват', icon: Aperture },
  { id: 'streamer', label: 'Стример', icon: Radio },
  { id: 'settings', label: 'Настройки', icon: Settings },
]

const RESOURCE_LABELS = {
  protocol: 'совместимость приложения',
  snapshot: 'версия приложения',
  auth: 'профиль',
  realtime: 'обновления в реальном времени',
  capture: 'захват',
  monitor: 'мониторинг',
  widget: 'виджет',
  settings: 'настройки',
  update: 'обновления',
} as const

export function App(): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('home')
  const [shellError, setShellError] = useState<string | null>(null)
  const pageHeadingRef = useRef<HTMLHeadingElement>(null)
  const firstSectionRender = useRef(true)
  const {
    data,
    retry,
    setAuth,
    setCapture,
    setMonitor,
    setWidget,
    setSettings,
    setUpdate,
  } = useAppBootstrap()

  useEffect(() => {
    document.documentElement.classList.toggle(
      'reduced-motion',
      data.settings.value?.reducedMotion === true,
    )
    return () => document.documentElement.classList.remove('reduced-motion')
  }, [data.settings.value?.reducedMotion])

  useEffect(() => {
    if (firstSectionRender.current) {
      firstSectionRender.current = false
      return
    }
    pageHeadingRef.current?.focus()
  }, [section])

  const activeItem = NAVIGATION.find((item) => item.id === section) ?? NAVIGATION[0]
  const monitorActive = ['PREFLIGHT', 'STARTING', 'READY', 'STOPPING'].includes(
    data.monitor.value?.state ?? '',
  )
  const resourceEntries = [
    ['protocol', data.protocol],
    ['snapshot', data.snapshot],
    ['auth', data.auth],
    ['realtime', data.realtime],
    ['capture', data.capture],
    ['monitor', data.monitor],
    ['widget', data.widget],
    ['settings', data.settings],
    ['update', data.update],
  ] as const
  const failedResources = resourceEntries
    .filter(([, resource]) => resource.state === 'error')
    .map(([key]) => RESOURCE_LABELS[key])
  const updateAvailable =
    data.update.value?.state === 'AVAILABLE' || data.update.value?.state === 'READY'
  const profile = section === 'settings' ? 'focused' : 'dashboard'

  const logout = async (): Promise<void> => {
    setShellError(null)
    try {
      setAuth(await window.crTools.logout())
    } catch {
      setShellError('Не удалось выйти из профиля. Повторите операцию.')
    }
  }

  const openWidget = async (): Promise<void> => {
    setShellError(null)
    try {
      setWidget(await window.crTools.showWidget())
    } catch {
      setShellError('Не удалось открыть виджет соперника.')
    }
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand" aria-label="CR Tools V2">
          <div className="brand-mark" aria-hidden="true">
            CR
          </div>
          <div className="brand-copy">
            <strong>CR Tools</strong>
            <span>Инструменты мониторинга</span>
          </div>
        </div>
        <nav className="navigation" aria-label="Основная навигация">
          {NAVIGATION.map((item) => {
            const Icon = item.icon
            return (
              <button
                aria-current={section === item.id ? 'page' : undefined}
                aria-label={item.label}
                className="nav-item"
                data-active={section === item.id}
                key={item.id}
                onClick={() => setSection(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" size={19} strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="runtime-badge" aria-live="polite">
          <Status
            label={realtimeLabel(data.realtime.value)}
            value="Обновления в реальном времени"
            tone={
              data.realtime.value === null
                ? 'loading'
                : data.realtime.value.state === 'READY'
                  ? 'success'
                  : data.realtime.value.state === 'DISCONNECTED'
                    ? 'danger'
                    : 'loading'
            }
          />
        </div>
        <span className="sidebar-version">
          Версия {data.snapshot.value?.version ?? 'проверяется'}
        </span>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="shell-container" data-profile={profile}>
            <div className="page-identity">
              <h1 ref={pageHeadingRef} tabIndex={-1}>
                {activeItem?.label ?? 'Главная'}
              </h1>
              <span>
                {data.monitor.value === null
                  ? 'Получаем состояние мониторинга'
                  : monitorActive
                    ? 'Мониторинг активен'
                    : 'Мониторинг не запущен'}
              </span>
            </div>
            <div className="global-indicators" aria-label="Состояние приложения">
              <Status
                label={
                  data.capture.value === null
                    ? 'Проверяем захват'
                    : data.capture.value.configured
                      ? 'Захват настроен'
                      : 'Настройте захват'
                }
                tone={
                  data.capture.value === null
                    ? 'loading'
                    : data.capture.value.configured
                      ? 'success'
                      : 'warning'
                }
              />
              {updateAvailable && (
                <button
                  className="update-indicator"
                  type="button"
                  onClick={() => setSection('settings')}
                >
                  {updateStateLabel(data.update.value?.state ?? null)}
                </button>
              )}
            </div>
            <div className="user-cluster">
              <div className="user-identity">
                <strong>{data.auth.value?.user?.username ?? 'Проверяем профиль'}</strong>
                <span>
                  {authLabel(data.auth.value?.user?.role, data.auth.value?.state)}
                </span>
              </div>
              <Button
                aria-label="Выйти из профиля"
                className="logout-button"
                variant="icon"
                onClick={() => void logout()}
              >
                <LogOut aria-hidden="true" size={17} />
                <span>Выйти</span>
              </Button>
            </div>
          </div>
        </header>

        <div className="page-stage shell-container" data-profile={profile}>
          {(failedResources.length > 0 || shellError !== null) && (
            <div className="global-notices">
              {failedResources.length > 0 && (
                <Alert title="Часть данных недоступна">
                  Не загрузились: {failedResources.join(', ')}.
                  <Button className="alert-action" onClick={retry}>
                    Повторить загрузку
                  </Button>
                </Alert>
              )}
              {shellError !== null && <Alert>{shellError}</Alert>}
            </div>
          )}

          {section === 'home' ? (
            <HomePage
              auth={data.auth.value}
              captureStatus={data.capture.value}
              monitorView={data.monitor.value}
              onMonitorView={setMonitor}
              onConfigure={() => setSection('capture')}
              onOpenWidget={() => void openWidget()}
            />
          ) : section === 'capture' ? (
            <CapturePage status={data.capture.value} onStatus={setCapture} />
          ) : section === 'settings' ? (
            <SettingsPage
              status={data.widget.value}
              onStatus={setWidget}
              appSettings={data.settings.value}
              onAppSettings={setSettings}
              updateView={data.update.value}
              onUpdateView={setUpdate}
            />
          ) : (
            <StreamerPage auth={data.auth.value} />
          )}
        </div>
      </main>
    </div>
  )
}
