import {
  Aperture,
  AlertCircle,
  ChevronRight,
  House,
  LogOut,
  Radio,
  Settings,
  ShieldCheck,
  Monitor,
  Play,
  RefreshCw,
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
            <strong>Realtime {realtime?.state ?? 'CHECKING'}</strong>
            <span>production server</span>
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span>
            <h1>{activeItem.label}</h1>
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
          <CapturePage onStatus={setCaptureStatus} />
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
      </main>
    </div>
  )
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
  const authenticated = auth?.state === 'AUTHENTICATED'
  const configured = captureStatus?.configured === true
  const monitorState = monitorView?.state ?? 'STOPPED'
  const active = ['PREFLIGHT', 'STARTING', 'READY', 'STOPPING'].includes(monitorState)
  const canStart = authenticated && configured && !active && !commandBusy
  const canStop = active && monitorState !== 'STOPPING' && !commandBusy

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
      label: 'Production API',
      ready: authenticated,
      detail: authenticated ? 'Сеанс подтверждён' : 'Нет активного сеанса',
    },
    {
      label: 'Realtime',
      ready: realtime?.state === 'READY',
      detail: realtime?.state ?? 'CHECKING',
    },
    {
      label: 'Захват',
      ready: configured,
      detail: configured
        ? (captureStatus.sourceLabel ?? 'Настроен')
        : 'Требуется настройка',
    },
  ]
  return (
    <div className="monitor-home">
      <section className="monitor-control-panel" aria-labelledby="monitor-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">LIVE RECOGNITION</span>
            <h2 id="monitor-title">Монитор соперника</h2>
          </div>
          <span
            className={`state-pill state-${monitorState === 'READY' ? 'ready' : monitorState === 'FAILED' ? 'failed' : 'checking'}`}
          >
            {monitorState}
          </span>
        </div>
        <p className="monitor-lead">
          Триггер проверяется локально. Только выбранная область данных отправляется в
          production OCR после подтверждения.
        </p>
        <div className="mode-groups">
          <ModeGroup<SearchMode>
            label="Поиск"
            options={[
              ['fast', 'Быстрый'],
              ['precise', 'Точный'],
            ]}
            value={monitorView?.preferences.searchMode ?? 'fast'}
            disabled={active || commandBusy}
            onChange={(searchMode) => void updatePreference({ searchMode })}
          />
          <ModeGroup<DeckMode>
            label="Режим колод"
            options={[
              ['pol', 'PoL'],
              ['gt', 'GT'],
            ]}
            value={monitorView?.preferences.deckMode ?? 'pol'}
            disabled={active || commandBusy}
            onChange={(deckMode) => void updatePreference({ deckMode })}
          />
        </div>
        {monitorView?.error !== null && monitorView?.error !== undefined && (
          <div className="monitor-error" role="alert">
            <AlertCircle aria-hidden="true" size={18} />
            <div>
              <strong>{monitorView.error.code}</strong>
              <span>{monitorView.error.message}</span>
            </div>
          </div>
        )}
        <div className="monitor-actions">
          {active ? (
            <button
              className="stop-button"
              type="button"
              disabled={!canStop}
              onClick={() => void runCommand('stop')}
            >
              <Square aria-hidden="true" size={16} />
              {monitorState === 'STOPPING' ? 'Остановка...' : 'Остановить'}
            </button>
          ) : (
            <button
              className="primary-button monitor-primary"
              type="button"
              disabled={!canStart}
              onClick={() => void runCommand('start')}
            >
              <Play aria-hidden="true" size={17} />
              Запустить монитор
            </button>
          )}
          {!configured && (
            <button
              className="text-button compact-link"
              type="button"
              onClick={onConfigure}
            >
              Настроить захват
              <ChevronRight aria-hidden="true" size={15} />
            </button>
          )}
        </div>
      </section>

      <section className="readiness-panel" aria-labelledby="readiness-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">PREFLIGHT</span>
            <h2 id="readiness-title">Готовность</h2>
          </div>
          <ShieldCheck aria-hidden="true" size={20} />
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
        <div className="runtime-caption">
          App {snapshot?.version ?? '...'} · IPC {ipcState} ·{' '}
          {snapshot?.lifecycle ?? 'BOOTING'}
        </div>
      </section>

      <SessionStats view={monitorView} />
      <section className="results-panel" aria-labelledby="results-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">SESSION FEED</span>
            <h2 id="results-title">Последние результаты</h2>
          </div>
          <span className="result-count">{monitorView?.results.length ?? 0} / 20</span>
        </div>
        {monitorView?.results.some((result) => result.kind === 'player_found') && (
          <button
            className="secondary-button result-widget-action"
            type="button"
            onClick={onOpenWidget}
          >
            <ExternalLink aria-hidden="true" size={15} />
            Открыть виджет
          </button>
        )}
        {monitorView === null || monitorView.results.length === 0 ? (
          <div className="results-empty">
            <UserSearch aria-hidden="true" size={26} />
            <strong>Результатов пока нет</strong>
            <span>
              После локального триггера здесь появится честный результат OCR и поиска.
            </span>
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
  )
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
        ['Триггеры', stats?.triggers ?? 0],
        ['Запросы', stats?.requests ?? 0],
        ['Найдены', stats?.playersFound ?? 0],
        ['Не найдены', stats?.playersNotFound ?? 0],
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

function ResultCard({ result }: { result: MonitorResult }): React.JSX.Element {
  const title =
    result.kind === 'player_found'
      ? result.player.name
      : result.kind === 'player_not_found'
        ? 'Игрок не найден'
        : result.kind === 'recognition_failed'
          ? 'Не удалось распознать'
          : 'Ошибка сервиса'
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
      <section className="settings-panel" aria-labelledby="widget-settings-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">LOCAL OVERLAY</span>
            <h2 id="widget-settings-heading">Виджет соперника</h2>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy || status === null}
            onClick={() => void show()}
          >
            Открыть виджет
          </button>
        </div>
        <p className="settings-intro">
          Отдельное локальное окно показывает только безопасную проекцию последнего
          результата. Изображения карт загружает основной процесс.
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
      <section className="honest-settings" aria-labelledby="application-settings-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">LOCAL APPLICATION</span>
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
              onChange={(launchAtStartup) => void updateApplication({ launchAtStartup })}
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
            <span className="eyebrow">SIGNED UPDATE CHANNEL</span>
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
            Издатель установщика не подписан Authenticode. Windows SmartScreen может
            показать неизбежное предупреждение «Неизвестный издатель». Подпись манифеста
            Ed25519 проверяет источник и целостность обновления, но не заменяет подпись
            Authenticode.
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
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  )
}

function CapturePage({
  onStatus,
}: {
  onStatus: (status: CaptureStatus) => void
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CaptureSourceSnapshot | null>(null)
  const [tab, setTab] = useState<'window' | 'display'>('window')
  const [loading, setLoading] = useState(true)
  const [startingKey, setStartingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await window.crTools.listCaptureSources())
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

  const sources = snapshot?.sources.filter((source) => source.kind === tab) ?? []
  return (
    <section className="capture-page" aria-labelledby="capture-heading">
      <div className="capture-intro">
        <div>
          <span className="eyebrow">CANONICAL SOURCE</span>
          <h2 id="capture-heading">Выберите окно или дисплей</h2>
          <p>
            Предпросмотр загружается только для видимых карточек. Настройка использует
            новый кадр из Windows Capture.
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw aria-hidden="true" size={16} />
          {loading ? 'Обновление' : 'Обновить'}
        </button>
      </div>
      <div className="source-tabs" role="tablist" aria-label="Тип источника">
        <button
          role="tab"
          aria-selected={tab === 'window'}
          onClick={() => setTab('window')}
          type="button"
        >
          Окна
        </button>
        <button
          role="tab"
          aria-selected={tab === 'display'}
          onClick={() => setTab('display')}
          type="button"
        >
          Дисплеи
        </button>
      </div>
      {error !== null && (
        <div className="inline-alert" role="alert">
          {error}
        </div>
      )}
      {!loading && sources.length === 0 ? (
        <div className="source-empty">
          <Monitor aria-hidden="true" size={26} />
          <strong>Источники не найдены</strong>
          <span>Откройте нужное окно и обновите список.</span>
        </div>
      ) : (
        <div className="source-grid">
          {sources.map((source) => (
            <SourceCard
              key={source.sourceKey}
              source={source}
              busy={startingKey === source.sourceKey}
              onStart={() => void start(source)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SourceCard({
  source,
  busy,
  onStart,
}: {
  source: CaptureSourceView
  busy: boolean
  onStart: () => void
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
    <article className="source-card" ref={cardRef}>
      <div className="source-preview">
        {preview !== null ? (
          <img src={preview.dataUrl} alt="" />
        ) : (
          <ScanLine aria-hidden="true" size={28} />
        )}
        {previewError && <span>Предпросмотр недоступен</span>}
      </div>
      <div className="source-card-body">
        <strong title={source.label}>{source.label}</strong>
        <span>
          {source.detail ?? (source.kind === 'window' ? 'Окно приложения' : 'Дисплей')}
        </span>
        {source.unavailableReason !== null && <p>{source.unavailableReason}</p>}
        <button
          className="primary-button"
          disabled={!source.captureSupported || busy}
          onClick={onStart}
          type="button"
        >
          {busy ? 'Получение кадра...' : 'Настроить источник'}
        </button>
      </div>
    </article>
  )
}
