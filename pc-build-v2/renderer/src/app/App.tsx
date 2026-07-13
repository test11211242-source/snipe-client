import {
  Aperture,
  AlertCircle,
  Check,
  ChevronRight,
  Clock3,
  House,
  LogOut,
  Radio,
  Settings,
  Monitor,
  Play,
  RefreshCw,
  Search,
  ScanLine,
  Square,
  UserSearch,
  ExternalLink,
  Download,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { AppSnapshot } from '../../../shared/models/application'
import type { AppSettingsView } from '../../../shared/contracts/app'
import type { AuthView } from '../../../shared/models/auth'
import type { RealtimeStatus } from '../../../shared/models/network'
import type {
  CaptureSourcePreview,
  CaptureSourceSnapshot,
  CaptureSourceView,
  CaptureStatus,
} from '../../../shared/models/capture'
import type {
  DeckMode,
  MonitorPreferences,
  MonitorResult,
  MonitorView,
  SearchMode,
} from '../../../shared/models/monitor'
import type {
  WidgetSettings as WidgetSettingsData,
  WidgetStatus,
} from '../../../shared/models/widget'
import type { UpdateView } from '../../../shared/models/update'
import { StreamerPage } from './StreamerPage'

type Section = 'home' | 'capture' | 'streamer' | 'settings'
interface NavigationItem {
  id: Section
  label: string
  icon: LucideIcon
}

const NAVIGATION: readonly NavigationItem[] = [
  { id: 'home', label: 'Главная', icon: House },
  { id: 'capture', label: 'Захват', icon: Aperture },
  { id: 'streamer', label: 'Стример', icon: Radio },
  { id: 'settings', label: 'Настройки', icon: Settings },
]
const HOME_NAVIGATION_ITEM: NavigationItem = { id: 'home', label: 'Главная', icon: House }

export function App(): React.JSX.Element {
  const [section, setSection] = useState<Section>('home')
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [auth, setAuth] = useState<AuthView | null>(null)
  const [realtime, setRealtime] = useState<RealtimeStatus | null>(null)
  const [ipcState, setIpcState] = useState<'checking' | 'ready' | 'failed'>('checking')
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null)
  const [monitorView, setMonitorView] = useState<MonitorView | null>(null)
  const [widgetStatus, setWidgetStatus] = useState<WidgetStatus | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettingsView | null>(null)

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const [
          ,
          nextSnapshot,
          nextAuth,
          nextRealtime,
          nextCaptureStatus,
          nextMonitor,
          nextWidget,
          nextSettings,
        ] = await Promise.all([
          window.crTools.hello(),
          window.crTools.getAppSnapshot(),
          window.crTools.getAuthView(),
          window.crTools.getRealtimeStatus(),
          window.crTools.getCaptureStatus(),
          window.crTools.getMonitorView(),
          window.crTools.getWidgetStatus(),
          window.crTools.getAppSettings(),
        ])
        if (!active) return
        setSnapshot(nextSnapshot)
        setAuth(nextAuth)
        setRealtime(nextRealtime)
        setCaptureStatus(nextCaptureStatus)
        setMonitorView(nextMonitor)
        setWidgetStatus(nextWidget)
        setAppSettings(nextSettings)
        setIpcState('ready')
      } catch {
        if (active) setIpcState('failed')
      }
    }
    void load()
    const timer = setInterval(() => {
      void window.crTools
        .getRealtimeStatus()
        .then((status) => {
          if (active) setRealtime(status)
        })
        .catch(() => undefined)
      void window.crTools
        .getCaptureStatus()
        .then((status) => {
          if (active) setCaptureStatus(status)
        })
        .catch(() => undefined)
      void window.crTools
        .getMonitorView()
        .then((view) => {
          if (active) setMonitorView(view)
        })
        .catch(() => undefined)
    }, 1_500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle(
      'reduced-motion',
      appSettings?.reducedMotion === true,
    )
    return () => document.documentElement.classList.remove('reduced-motion')
  }, [appSettings?.reducedMotion])

  const activeItem =
    NAVIGATION.find((item) => item.id === section) ?? HOME_NAVIGATION_ITEM
  const monitorActive = ['PREFLIGHT', 'STARTING', 'READY', 'STOPPING'].includes(
    monitorView?.state ?? 'STOPPED',
  )
  const logout = async (): Promise<void> => {
    setAuth(await window.crTools.logout())
  }

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand" aria-label="CR Tools V2">
          <div className="brand-mark" aria-hidden="true">
            CR
          </div>
          <div>
            <strong>CR Tools</strong>
            <span>V2 MONITOR CORE</span>
          </div>
        </div>
        <nav className="navigation" aria-label="Основная навигация">
          {NAVIGATION.map((item) => {
            const Icon = item.icon
            return (
              <button
                aria-current={section === item.id ? 'page' : undefined}
                className="nav-item"
                data-active={section === item.id}
                key={item.id}
                onClick={() => setSection(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="runtime-badge">
          <span
            className={`status-dot status-${realtime?.state === 'READY' ? 'ready' : realtime?.state === 'DISCONNECTED' ? 'failed' : 'checking'}`}
            aria-hidden="true"
          />
          <div>
            <strong>{realtimeLabel(realtime)}</strong>
            <span>Live-обновления</span>
          </div>
        </div>
        <span className="sidebar-version">Версия {snapshot?.version ?? '...'}</span>
      </aside>

      <main className="content">
        <header className="topbar">
          <div className="page-identity">
            <h1>{activeItem.label}</h1>
            <span>{monitorActive ? 'Мониторинг активен' : 'Мониторинг остановлен'}</span>
          </div>
          <div className="global-status" aria-label="Краткое состояние системы">
            <span data-tone={captureStatus?.configured === true ? 'ready' : 'attention'}>
              <i aria-hidden="true" />
              {captureStatus?.configured === true ? 'Захват готов' : 'Настройте захват'}
            </span>
            <span data-tone={realtime?.state === 'READY' ? 'ready' : 'neutral'}>
              <i aria-hidden="true" />
              {realtime?.state === 'READY'
                ? 'Realtime подключён'
                : 'Realtime подключается'}
            </span>
          </div>
          <div className="user-cluster">
            <div className="user-identity">
              <strong>{auth?.user?.username ?? 'Проверка профиля'}</strong>
              <span>{auth?.user?.role ?? auth?.state ?? 'loading'}</span>
            </div>
            <button className="logout-button" type="button" onClick={() => void logout()}>
              <LogOut aria-hidden="true" size={16} />
              <span>Выйти</span>
            </button>
          </div>
        </header>

        <div className="page-stage" key={section}>
          {section === 'home' ? (
            <Home
              snapshot={snapshot}
              auth={auth}
              realtime={realtime}
              ipcState={ipcState}
              captureStatus={captureStatus}
              monitorView={monitorView}
              onMonitorView={setMonitorView}
              onConfigure={() => setSection('capture')}
              onOpenWidget={() => void window.crTools.showWidget().then(setWidgetStatus)}
            />
          ) : section === 'capture' ? (
            <CapturePage status={captureStatus} onStatus={setCaptureStatus} />
          ) : section === 'settings' ? (
            <SettingsPage
              status={widgetStatus}
              onStatus={setWidgetStatus}
              appSettings={appSettings}
              onAppSettings={setAppSettings}
            />
          ) : (
            <StreamerPage auth={auth} />
          )}
        </div>
      </main>
    </div>
  )
}

function realtimeLabel(realtime: RealtimeStatus | null): string {
  if (realtime === null) return 'Проверяем соединение'
  if (realtime.state === 'READY') return 'Realtime подключён'
  if (realtime.state === 'DISCONNECTED') return 'Realtime отключён'
  if (realtime.state === 'BACKOFF') return 'Повторное подключение'
  return 'Realtime подключается'
}

function Home({
  snapshot,
  auth,
  realtime,
  ipcState,
  captureStatus,
  monitorView,
  onMonitorView,
  onConfigure,
  onOpenWidget,
}: {
  snapshot: AppSnapshot | null
  auth: AuthView | null
  realtime: RealtimeStatus | null
  ipcState: 'checking' | 'ready' | 'failed'
  captureStatus: CaptureStatus | null
  monitorView: MonitorView | null
  onMonitorView: (view: MonitorView) => void
  onConfigure: () => void
  onOpenWidget: () => void
}): React.JSX.Element {
  const [commandBusy, setCommandBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const authenticated = auth?.state === 'AUTHENTICATED'
  const configured = captureStatus?.configured === true
  const monitorState = monitorView?.state ?? 'STOPPED'
  const active = ['PREFLIGHT', 'STARTING', 'READY', 'STOPPING'].includes(monitorState)
  const sourceUnavailable = monitorView?.readiness.sourceAvailable === false
  const canStart = authenticated && configured && !active && !commandBusy
  const canStop = active && monitorState !== 'STOPPING' && !commandBusy

  useEffect(() => {
    if (
      !active ||
      monitorView?.startedAt === null ||
      monitorView?.startedAt === undefined
    )
      return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active, monitorView?.startedAt])

  const runCommand = async (command: 'start' | 'stop'): Promise<void> => {
    setCommandBusy(true)
    try {
      onMonitorView(
        command === 'start'
          ? await window.crTools.startMonitor()
          : await window.crTools.stopMonitor(),
      )
    } finally {
      setCommandBusy(false)
    }
  }

  const updatePreference = async (patch: Partial<MonitorPreferences>): Promise<void> => {
    if (monitorView === null) return
    setCommandBusy(true)
    try {
      const preferences = await window.crTools.updateMonitorPreferences({
        ...monitorView.preferences,
        ...patch,
      })
      onMonitorView({ ...monitorView, preferences })
    } finally {
      setCommandBusy(false)
    }
  }

  const readiness = [
    {
      label: 'Учётная запись',
      ready: authenticated,
      detail: authenticated ? (auth.user?.username ?? 'Вход выполнен') : 'Требуется вход',
    },
    {
      label: 'Сервис распознавания',
      ready: authenticated,
      detail: authenticated ? 'Сеанс подтверждён' : 'Нет активного сеанса',
    },
    {
      label: 'Live-обновления',
      ready: realtime?.state === 'READY',
      detail: realtimeLabel(realtime),
    },
    {
      label: 'Источник захвата',
      ready: configured && !sourceUnavailable,
      detail: !configured
        ? 'Требуется настройка'
        : sourceUnavailable
          ? 'Источник недоступен'
          : (captureStatus.sourceLabel ?? 'Настроен'),
    },
  ]
  const hero = getHomePresentation(monitorView, configured, sourceUnavailable)
  const startedAt = monitorView?.startedAt
  const sessionDuration =
    startedAt === null || startedAt === undefined
      ? null
      : formatDuration(Math.max(0, now - Date.parse(startedAt)))
  const primaryDisabled =
    monitorView === null
      ? true
      : active
        ? !canStop
        : configured && !sourceUnavailable
          ? !canStart
          : commandBusy
  const runPrimary = (): void => {
    if (active) void runCommand('stop')
    else if (!configured || sourceUnavailable) onConfigure()
    else void runCommand('start')
  }

  return (
    <div className="monitor-home">
      <div className="home-main-column">
        <section
          className="monitor-control-panel"
          data-state={hero.tone}
          aria-labelledby="monitor-title"
        >
          <div className="monitor-hero-copy">
            <div className="monitor-state-line">
              <span className="status-dot" data-tone={hero.tone} aria-hidden="true" />
              <span>{hero.kicker}</span>
            </div>
            <h2 id="monitor-title">{hero.title}</h2>
            <p className="monitor-lead">{hero.description}</p>
            {monitorView?.error !== null && monitorView?.error !== undefined && (
              <div className="monitor-error" role="alert">
                <AlertCircle aria-hidden="true" size={17} />
                <div>
                  <strong>Не удалось продолжить</strong>
                  <span>{monitorView.error.message}</span>
                </div>
              </div>
            )}
            <div className="monitor-actions">
              <button
                className={active ? 'stop-button' : 'primary-button monitor-primary'}
                type="button"
                disabled={primaryDisabled}
                onClick={runPrimary}
              >
                {active ? (
                  <Square aria-hidden="true" size={15} />
                ) : configured && !sourceUnavailable ? (
                  <Play aria-hidden="true" size={16} />
                ) : (
                  <Aperture aria-hidden="true" size={16} />
                )}
                {commandBusy
                  ? active
                    ? 'Останавливаем...'
                    : 'Проверяем...'
                  : hero.action}
              </button>
            </div>
          </div>
          <div className="monitor-hero-context">
            {sessionDuration !== null && active && (
              <div className="session-time">
                <Clock3 aria-hidden="true" size={15} />
                <span>Время сессии</span>
                <strong>{sessionDuration}</strong>
              </div>
            )}
            <div className="mode-groups">
              <ModeGroup<SearchMode>
                label="Поиск"
                options={[
                  ['fast', 'Быстрый'],
                  ['precise', 'Точный'],
                ]}
                value={monitorView?.preferences.searchMode ?? 'fast'}
                disabled={active || commandBusy || monitorView === null}
                onChange={(searchMode) => void updatePreference({ searchMode })}
              />
              <ModeGroup<DeckMode>
                label="Режим колод"
                options={[
                  ['pol', 'PoL'],
                  ['gt', 'GT'],
                ]}
                value={monitorView?.preferences.deckMode ?? 'pol'}
                disabled={active || commandBusy || monitorView === null}
                onChange={(deckMode) => void updatePreference({ deckMode })}
              />
            </div>
          </div>
        </section>

        <SessionStats view={monitorView} />
        <section className="results-panel" aria-labelledby="results-title">
          <div className="section-heading results-heading">
            <div>
              <span className="eyebrow">ИСТОРИЯ СЕССИИ</span>
              <h2 id="results-title">Последние результаты</h2>
            </div>
            <div className="results-tools">
              <span className="result-count">
                {monitorView?.results.length ?? 0} / 20
              </span>
              {monitorView?.results.some((result) => result.kind === 'player_found') && (
                <button
                  className="secondary-button result-widget-action"
                  type="button"
                  onClick={onOpenWidget}
                >
                  <ExternalLink aria-hidden="true" size={14} />
                  Открыть виджет
                </button>
              )}
            </div>
          </div>
          {monitorView === null ? (
            <div className="results-loading" aria-label="Загрузка результатов">
              <span />
              <span />
              <span />
            </div>
          ) : monitorView.results.length === 0 ? (
            <div className="results-empty">
              <UserSearch aria-hidden="true" size={23} />
              <strong>Результатов пока нет</strong>
              <span>Они появятся здесь после первого распознавания.</span>
            </div>
          ) : (
            <div className="result-list">
              {monitorView.results.map((result) => (
                <ResultCard key={result.id} result={result} />
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="home-context" aria-label="Контекст мониторинга">
        <section className="readiness-panel" aria-labelledby="readiness-title">
          <div className="section-heading compact-heading">
            <div>
              <span className="eyebrow">ПОДГОТОВКА</span>
              <h2 id="readiness-title">Готовность системы</h2>
            </div>
            <span className="readiness-total">
              {readiness.filter((item) => item.ready).length}/{readiness.length}
            </span>
          </div>
          <div className="readiness-list">
            {readiness.map((item) => (
              <div className="readiness-row" key={item.label} data-ready={item.ready}>
                <span className="readiness-marker" aria-hidden="true" />
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="context-section current-configuration">
          <span className="eyebrow">КОНФИГУРАЦИЯ</span>
          <dl>
            <div>
              <dt>Источник</dt>
              <dd>{captureStatus?.sourceLabel ?? 'Не выбран'}</dd>
            </div>
            <div>
              <dt>Поиск</dt>
              <dd>
                {monitorView?.preferences.searchMode === 'precise' ? 'Точный' : 'Быстрый'}
              </dd>
            </div>
            <div>
              <dt>Колоды</dt>
              <dd>{(monitorView?.preferences.deckMode ?? 'pol').toUpperCase()}</dd>
            </div>
          </dl>
          <button
            className="text-button compact-link"
            type="button"
            onClick={onConfigure}
          >
            Изменить захват
            <ChevronRight aria-hidden="true" size={14} />
          </button>
        </section>

        <section className="context-section recent-activity">
          <span className="eyebrow">ПОСЛЕДНЯЯ АКТИВНОСТЬ</span>
          {monitorView === null || monitorView.results.length === 0 ? (
            <p>Событий этой сессии пока нет.</p>
          ) : (
            <ol>
              {monitorView.results.slice(0, 4).map((result) => (
                <li key={result.id} data-kind={result.kind}>
                  <span aria-hidden="true" />
                  <div>
                    <strong>{resultTitle(result)}</strong>
                    <time dateTime={result.timestamp}>
                      {new Date(result.timestamp).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="runtime-caption">
          App {snapshot?.version ?? '...'} · IPC {ipcState} ·{' '}
          {snapshot?.lifecycle ?? 'BOOTING'}
        </div>
      </aside>
    </div>
  )
}

function getHomePresentation(
  view: MonitorView | null,
  configured: boolean,
  sourceUnavailable: boolean,
): { kicker: string; title: string; description: string; action: string; tone: string } {
  if (view === null) {
    return {
      kicker: 'Синхронизация',
      title: 'Получаем состояние системы',
      description: 'Проверяем источник захвата и готовность локальных сервисов.',
      action: 'Подождите...',
      tone: 'neutral',
    }
  }
  if (view.state === 'PREFLIGHT' || view.state === 'STARTING') {
    return {
      kicker: 'Запуск',
      title: 'Проверяем готовность',
      description: 'Подготавливаем источник и локальный мониторинг соперника.',
      action: 'Остановить мониторинг',
      tone: 'attention',
    }
  }
  if (view.state === 'READY') {
    return {
      kicker: 'Активная сессия',
      title: 'Мониторинг активен',
      description: 'Ожидаем игровой триггер и следующий результат распознавания.',
      action: 'Остановить мониторинг',
      tone: 'ready',
    }
  }
  if (view.state === 'STOPPING') {
    return {
      kicker: 'Завершение сессии',
      title: 'Останавливаем мониторинг',
      description: 'Корректно завершаем локальный процесс и текущие операции.',
      action: 'Останавливаем...',
      tone: 'attention',
    }
  }
  if (!configured) {
    return {
      kicker: 'Требуется настройка',
      title: 'Выберите источник захвата',
      description: 'Укажите окно Clash Royale или монитор перед запуском распознавания.',
      action: 'Выбрать источник',
      tone: 'attention',
    }
  }
  if (sourceUnavailable) {
    return {
      kicker: 'Источник недоступен',
      title: 'Окно захвата не найдено',
      description: 'Откройте Clash Royale или выберите другой доступный источник.',
      action: 'Выбрать другой источник',
      tone: 'attention',
    }
  }
  if (view.state === 'FAILED') {
    return {
      kicker: 'Сессия остановлена',
      title: 'Мониторинг не запущен',
      description:
        view.error?.message ?? 'Проверьте состояние системы и повторите запуск.',
      action: 'Повторить запуск',
      tone: 'failed',
    }
  }
  return {
    kicker: 'Готово к работе',
    title: 'Система готова',
    description: 'Источник настроен. Можно запускать мониторинг соперника.',
    action: 'Запустить мониторинг',
    tone: 'ready',
  }
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

function ModeGroup<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string
  options: readonly (readonly [T, string])[]
  value: T
  disabled: boolean
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <fieldset className="mode-group" disabled={disabled}>
      <legend>{label}</legend>
      <div>
        {options.map(([id, text]) => (
          <button
            type="button"
            key={id}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function SessionStats({ view }: { view: MonitorView | null }): React.JSX.Element {
  const stats = view?.stats
  return (
    <section className="stats-strip" aria-label="Статистика сессии">
      {[
        ['Найдены', stats?.playersFound ?? 0],
        ['Не найдены', stats?.playersNotFound ?? 0],
        ['Не распознано', stats?.recognitionFailures ?? 0],
        ['Ошибки сервиса', stats?.serviceErrors ?? 0],
        ['Пропущено', stats?.droppedActions ?? 0],
      ].map(([label, value]) => (
        <div key={label}>
          <strong>{value}</strong>
          <span>{label}</span>
        </div>
      ))}
    </section>
  )
}

function resultTitle(result: MonitorResult): string {
  return result.kind === 'player_found'
    ? result.player.name
    : result.kind === 'player_not_found'
      ? 'Игрок не найден'
      : result.kind === 'recognition_failed'
        ? 'Не удалось распознать'
        : 'Ошибка сервиса'
}

function ResultCard({ result }: { result: MonitorResult }): React.JSX.Element {
  const title = resultTitle(result)
  const detail =
    result.kind === 'player_found'
      ? [result.player.tag, result.player.rating, result.player.clan]
          .filter((value) => value !== null)
          .join(' · ') || 'Профиль найден'
      : result.message
  return (
    <article className="result-card" data-kind={result.kind}>
      <div className="result-status" aria-hidden="true" />
      <div>
        <div className="result-title">
          <strong>{title}</strong>
          <time dateTime={result.timestamp}>
            {new Date(result.timestamp).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        <p>{detail}</p>
        <span>
          {result.searchMode.toUpperCase()} · {result.deckMode.toUpperCase()}
          {result.searchedNickname !== null
            ? ` · запрос: ${result.searchedNickname}`
            : ''}
        </span>
        {result.kind === 'player_found' && result.decks.length > 0 && (
          <small>{result.decks.length} колод сохранено для локального виджета</small>
        )}
      </div>
    </article>
  )
}

function SettingsPage({
  status,
  onStatus,
  appSettings,
  onAppSettings,
}: {
  status: WidgetStatus | null
  onStatus: (status: WidgetStatus) => void
  appSettings: AppSettingsView | null
  onAppSettings: (settings: AppSettingsView) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [updateView, setUpdateView] = useState<UpdateView | null>(null)

  useEffect(() => {
    let active = true
    const refresh = (): void => {
      void window.crTools
        .getUpdateView()
        .then((view) => {
          if (active) setUpdateView(view)
        })
        .catch(() => undefined)
    }
    refresh()
    const timer = setInterval(refresh, 500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const update = async (patch: Partial<WidgetSettingsData>): Promise<void> => {
    if (status === null) return
    setBusy(true)
    try {
      const settings = await window.crTools.updateWidgetSettings({
        ...status.settings,
        ...patch,
      })
      onStatus({ ...status, settings })
    } finally {
      setBusy(false)
    }
  }

  const show = async (): Promise<void> => {
    setBusy(true)
    try {
      onStatus(await window.crTools.showWidget())
    } finally {
      setBusy(false)
    }
  }

  const updateApplication = async (patch: Partial<AppSettingsView>): Promise<void> => {
    if (appSettings === null) return
    setBusy(true)
    try {
      onAppSettings(await window.crTools.updateAppSettings({ ...appSettings, ...patch }))
    } finally {
      setBusy(false)
    }
  }

  const runUpdateCommand = async (
    command: 'check' | 'download' | 'cancel' | 'install',
  ): Promise<void> => {
    setBusy(true)
    try {
      const view =
        command === 'check'
          ? await window.crTools.checkForUpdate()
          : command === 'download'
            ? await window.crTools.downloadUpdate()
            : command === 'cancel'
              ? await window.crTools.cancelUpdate()
              : await window.crTools.installUpdate()
      setUpdateView(view)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page">
      <header className="settings-page-heading">
        <div>
          <span className="eyebrow">ПЕРСОНАЛИЗАЦИЯ</span>
          <h2>Настройки приложения</h2>
          <p>Поведение виджета, системные параметры и обновления CR Tools.</p>
        </div>
      </header>
      <div className="settings-layout">
        <section
          className="settings-panel settings-widget-panel"
          aria-labelledby="widget-settings-heading"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">ОКНО СОПЕРНИКА</span>
              <h2 id="widget-settings-heading">Виджет соперника</h2>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || status === null}
              onClick={() => void show()}
            >
              Открыть виджет
            </button>
          </div>
          <p className="settings-intro">
            Настройте поведение отдельного окна с последним найденным соперником.
          </p>
          {status === null ? (
            <div className="settings-loading">Загрузка настроек...</div>
          ) : (
            <div className="settings-form">
              <SettingToggle
                label="Открывать при найденном игроке"
                detail="Ошибки и результаты «не найден» окно не открывают."
                checked={status.settings.autoOpen}
                disabled={busy}
                onChange={(autoOpen) => void update({ autoOpen })}
              />
              <SettingToggle
                label="Поверх остальных окон"
                detail="Сохраняет колоду видимой рядом с игрой."
                checked={status.settings.alwaysOnTop}
                disabled={busy}
                onChange={(alwaysOnTop) => void update({ alwaysOnTop })}
              />
              <SettingToggle
                label="Заблокировать положение"
                detail="Отключает перемещение и изменение размера окна."
                checked={status.settings.locked}
                disabled={busy}
                onChange={(locked) => void update({ locked })}
              />
              <SettingToggle
                label="Компактный режим"
                detail="Скрывает второстепенные сведения и уменьшает карточки."
                checked={status.settings.compactMode}
                disabled={busy}
                onChange={(compactMode) => void update({ compactMode })}
              />
              <label className="setting-range">
                <span>
                  <strong>Прозрачность</strong>
                  <small>От 55% до полностью непрозрачного окна.</small>
                </span>
                <input
                  aria-label="Прозрачность виджета"
                  type="range"
                  min="55"
                  max="100"
                  step="5"
                  disabled={busy}
                  value={Math.round(status.settings.opacity * 100)}
                  onChange={(event) =>
                    void update({ opacity: Number(event.currentTarget.value) / 100 })
                  }
                />
                <output>{Math.round(status.settings.opacity * 100)}%</output>
              </label>
            </div>
          )}
        </section>
        <section
          className="honest-settings application-settings"
          aria-labelledby="application-settings-heading"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">ПРИЛОЖЕНИЕ</span>
              <h2 id="application-settings-heading">Приложение</h2>
            </div>
          </div>
          {appSettings === null ? (
            <div className="settings-loading">Загрузка настроек...</div>
          ) : (
            <div className="settings-form">
              <SettingToggle
                label="Уменьшить движение"
                detail="Отключает декоративные анимации и переходы интерфейса."
                checked={appSettings.reducedMotion}
                disabled={busy}
                onChange={(reducedMotion) => void updateApplication({ reducedMotion })}
              />
              <SettingToggle
                label="Запускать вместе с Windows"
                detail="Изменяет системный параметр автозапуска только в Windows."
                checked={appSettings.launchAtStartup}
                disabled={busy}
                onChange={(launchAtStartup) =>
                  void updateApplication({ launchAtStartup })
                }
              />
              <SettingToggle
                label="Подробная локальная диагностика"
                detail="Включает отладочные записи локального журнала. Данные автоматически не отправляются."
                checked={appSettings.diagnosticsEnabled}
                disabled={busy}
                onChange={(diagnosticsEnabled) =>
                  void updateApplication({ diagnosticsEnabled })
                }
              />
            </div>
          )}
        </section>
        <section
          className="honest-settings update-settings"
          aria-labelledby="update-heading"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">ОБНОВЛЕНИЯ</span>
              <h2 id="update-heading">Обновления приложения</h2>
            </div>
            <span
              className={`state-pill state-${updateView?.state === 'READY' || updateView?.state === 'UP_TO_DATE' ? 'ready' : updateView?.state === 'FAILED' ? 'failed' : 'checking'}`}
            >
              {updateView?.state ?? 'LOADING'}
            </span>
          </div>
          <div className="unsigned-warning" role="note">
            <AlertCircle aria-hidden="true" size={18} />
            <p>
              Windows может показать предупреждение «Неизвестный издатель». Перед
              установкой приложение отдельно проверяет источник и целостность обновления.
            </p>
          </div>
          <dl className="update-summary">
            <div>
              <dt>Текущая версия</dt>
              <dd>{updateView?.currentVersion ?? '...'}</dd>
            </div>
            <div>
              <dt>Доступная версия</dt>
              <dd>{updateView?.availableVersion ?? 'нет'}</dd>
            </div>
          </dl>
          {updateView?.progress !== null && updateView?.progress !== undefined && (
            <div className="update-progress">
              <div>
                <strong>Загрузка {updateView.progress.percent.toFixed(1)}%</strong>
                <span>
                  {formatBytes(updateView.progress.downloadedBytes)} /{' '}
                  {formatBytes(updateView.progress.totalBytes)}
                </span>
              </div>
              <progress
                value={updateView.progress.downloadedBytes}
                max={updateView.progress.totalBytes}
              />
            </div>
          )}
          {updateView?.error !== null && updateView?.error !== undefined && (
            <div className="inline-alert" role="alert">
              {updateView.error.message}
              {updateView.error.retryable ? ' Повторите операцию.' : ''}
            </div>
          )}
          {updateView !== null && updateView.releaseNotes.length > 0 && (
            <div className="release-notes">
              <strong>
                {updateView.critical ? 'Критическое обновление' : 'Что нового'}
              </strong>
              <ul>
                {updateView.releaseNotes.map((note, index) => (
                  <li key={`${index}-${note}`}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="update-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={
                busy ||
                updateView?.state === 'CHECKING' ||
                updateView?.state === 'DOWNLOADING'
              }
              onClick={() => void runUpdateCommand('check')}
            >
              <RefreshCw aria-hidden="true" size={16} />
              Проверить
            </button>
            {updateView?.state === 'AVAILABLE' && (
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => void runUpdateCommand('download')}
              >
                <Download aria-hidden="true" size={16} />
                Скачать
              </button>
            )}
            {updateView?.state === 'DOWNLOADING' && (
              <button
                className="danger-button"
                type="button"
                onClick={() => void runUpdateCommand('cancel')}
              >
                <X aria-hidden="true" size={16} />
                Отменить
              </button>
            )}
            {updateView?.state === 'READY' && (
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => void runUpdateCommand('install')}
              >
                Установить и перезапустить
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function SettingToggle({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string
  detail: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="setting-toggle">
      <span className="setting-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <span className="switch-control">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span aria-hidden="true" />
      </span>
    </label>
  )
}

function CapturePage({
  status,
  onStatus,
}: {
  status: CaptureStatus | null
  onStatus: (status: CaptureStatus) => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CaptureSourceSnapshot | null>(null)
  const [tab, setTab] = useState<'window' | 'display'>('window')
  const [loading, setLoading] = useState(true)
  const [startingKey, setStartingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [availableOnly, setAvailableOnly] = useState(true)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const nextSnapshot = await window.crTools.listCaptureSources()
      setSnapshot(nextSnapshot)
      setSelectedKey((current) =>
        nextSnapshot.sources.some((source) => source.sourceKey === current)
          ? current
          : null,
      )
    } catch {
      setError('Не удалось получить источники. Захват доступен только в Windows.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void window.crTools
      .listCaptureSources()
      .then(
        (value) => {
          if (active) setSnapshot(value)
        },
        () => {
          if (active)
            setError('Не удалось получить источники. Захват доступен только в Windows.')
        },
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const start = async (source: CaptureSourceView): Promise<void> => {
    if (!source.captureSupported) return
    setStartingKey(source.sourceKey)
    setError(null)
    try {
      await window.crTools.startCaptureSetup({
        sourceKey: source.sourceKey,
        revision: source.revision,
      })
      onStatus(await window.crTools.getCaptureStatus())
    } catch {
      setError(
        'Источник изменился или захват не запустился. Обновите список и повторите.',
      )
    } finally {
      setStartingKey(null)
    }
  }

  const allSources = snapshot?.sources ?? []
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU')
  const sources = allSources.filter(
    (source) =>
      source.kind === tab &&
      (!availableOnly || source.captureSupported) &&
      (normalizedQuery.length === 0 ||
        source.label.toLocaleLowerCase('ru-RU').includes(normalizedQuery) ||
        source.detail?.toLocaleLowerCase('ru-RU').includes(normalizedQuery) === true),
  )
  const selectedSource =
    allSources.find((source) => source.sourceKey === selectedKey) ?? null
  const windowCount = allSources.filter((source) => source.kind === 'window').length
  const displayCount = allSources.filter((source) => source.kind === 'display').length
  return (
    <section className="capture-page" aria-labelledby="capture-heading">
      <div className="capture-intro">
        <div>
          <span className="eyebrow">ИСТОЧНИК ИЗОБРАЖЕНИЯ</span>
          <h2 id="capture-heading">Источник захвата</h2>
          <p>
            Выберите окно Clash Royale или монитор. Области распознавания настраиваются на
            следующем шаге.
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw aria-hidden="true" size={16} />
          {loading ? 'Обновляем...' : 'Обновить список'}
        </button>
      </div>

      <div className="source-toolbar">
        <label className="source-search">
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">Поиск источника</span>
          <input
            type="search"
            value={query}
            placeholder="Поиск по названию"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div className="source-tabs" role="tablist" aria-label="Тип источника">
          <button
            role="tab"
            aria-selected={tab === 'window'}
            onClick={() => setTab('window')}
            type="button"
          >
            Окна <span>{windowCount}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'display'}
            onClick={() => setTab('display')}
            type="button"
          >
            Мониторы <span>{displayCount}</span>
          </button>
        </div>
        <button
          className="availability-filter"
          type="button"
          aria-pressed={availableOnly}
          onClick={() => setAvailableOnly((value) => !value)}
        >
          Только доступные
        </button>
      </div>

      <div className="capture-workspace">
        <div className="source-browser">
          {loading && snapshot === null ? (
            <div className="source-grid" aria-label="Загрузка источников">
              {Array.from({ length: 6 }, (_, index) => (
                <div className="source-card source-card-skeleton" key={index}>
                  <span />
                  <div>
                    <i />
                    <i />
                  </div>
                </div>
              ))}
            </div>
          ) : sources.length === 0 ? (
            <div className="source-empty">
              <Monitor aria-hidden="true" size={24} />
              <strong>
                {normalizedQuery.length > 0
                  ? `По запросу «${query.trim()}» ничего не найдено`
                  : 'Источники не найдены'}
              </strong>
              <span>
                {normalizedQuery.length > 0
                  ? 'Измените запрос или переключите тип источника.'
                  : 'Откройте нужное окно и обновите список.'}
              </span>
            </div>
          ) : (
            <div className="source-grid">
              {sources.map((source) => (
                <SourceCard
                  key={source.sourceKey}
                  source={source}
                  selected={selectedKey === source.sourceKey}
                  disabled={startingKey !== null}
                  busy={startingKey === source.sourceKey}
                  onSelect={() => setSelectedKey(source.sourceKey)}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="source-selection" aria-live="polite">
          <div>
            <span className="eyebrow">ТЕКУЩАЯ КОНФИГУРАЦИЯ</span>
            <strong>{status?.sourceLabel ?? 'Источник не настроен'}</strong>
            <p>
              {status?.configured === true
                ? `Конфигурация ${status.revision ?? ''} активна.`
                : 'Перед запуском мониторинга выберите источник.'}
            </p>
          </div>
          <div className="selection-summary">
            <span className="eyebrow">ВЫБРАННЫЙ ИСТОЧНИК</span>
            {selectedSource === null ? (
              <p>Выберите окно или монитор слева.</p>
            ) : (
              <>
                <strong>{selectedSource.label}</strong>
                <span>
                  {selectedSource.detail ??
                    (selectedSource.kind === 'window' ? 'Окно приложения' : 'Монитор')}
                </span>
                <p>Настройка областей откроется в отдельном окне.</p>
              </>
            )}
          </div>
          {error !== null && (
            <div className="inline-alert" role="alert">
              <AlertCircle aria-hidden="true" size={16} />
              <span>{error}</span>
            </div>
          )}
          <button
            className="primary-button source-continue"
            type="button"
            disabled={
              selectedSource === null ||
              !selectedSource.captureSupported ||
              startingKey !== null
            }
            onClick={() => selectedSource !== null && void start(selectedSource)}
          >
            {startingKey !== null ? 'Получаем кадр...' : 'Продолжить к настройке'}
            {startingKey === null && <ChevronRight aria-hidden="true" size={15} />}
          </button>
        </aside>
      </div>
    </section>
  )
}

function SourceCard({
  source,
  selected,
  disabled,
  busy,
  onSelect,
}: {
  source: CaptureSourceView
  selected: boolean
  disabled: boolean
  busy: boolean
  onSelect: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<CaptureSourcePreview | null>(null)
  const [previewError, setPreviewError] = useState(false)
  const [visible, setVisible] = useState(false)
  const cardRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const node = cardRef.current
    if (node === null || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '120px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let active = true
    void window.crTools
      .getCapturePreview({ sourceKey: source.sourceKey, revision: source.revision })
      .then((value) => {
        if (active) setPreview(value)
      })
      .catch(() => {
        if (active) setPreviewError(true)
      })
    return () => {
      active = false
    }
  }, [source.revision, source.sourceKey, visible])

  return (
    <article
      className="source-card"
      ref={cardRef}
      data-selected={selected}
      data-unavailable={!source.captureSupported}
    >
      <button
        className="source-card-select"
        type="button"
        aria-pressed={selected}
        disabled={disabled || !source.captureSupported}
        onClick={onSelect}
      >
        <div className="source-preview">
          {preview !== null ? (
            <img src={preview.dataUrl} alt="" />
          ) : (
            <ScanLine
              className={busy ? 'is-spinning' : undefined}
              aria-hidden="true"
              size={25}
            />
          )}
          {previewError && <span>Предпросмотр недоступен</span>}
          {selected && (
            <span className="source-selected-mark" aria-hidden="true">
              <Check size={13} />
            </span>
          )}
        </div>
        <div className="source-card-body">
          <div>
            <strong title={source.label}>{source.label}</strong>
            <span>
              {source.detail ??
                (source.kind === 'window' ? 'Окно приложения' : 'Монитор')}
            </span>
          </div>
          <small>
            {preview !== null
              ? `${preview.size.width} × ${preview.size.height}`
              : source.captureSupported
                ? 'Загружаем preview'
                : 'Недоступен'}
          </small>
          {source.unavailableReason !== null && <p>{source.unavailableReason}</p>}
        </div>
      </button>
    </article>
  )
}
