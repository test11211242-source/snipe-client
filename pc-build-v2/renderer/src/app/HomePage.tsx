import {
  AlertCircle,
  Aperture,
  ChevronRight,
  Clock3,
  ExternalLink,
  Play,
  Square,
  UserSearch,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import type { AuthView } from '../../../shared/models/auth'
import type { CaptureStatus } from '../../../shared/models/capture'
import type {
  DeckMode,
  MonitorPreferences,
  MonitorResult,
  MonitorView,
  SearchMode,
} from '../../../shared/models/monitor'
import { formatDeckCount, publicErrorMessage } from './format'
import { Alert, Button, Section } from './ui'

export function HomePage({
  auth,
  captureStatus,
  monitorView,
  onMonitorView,
  onConfigure,
  onOpenWidget,
}: {
  auth: AuthView | null
  captureStatus: CaptureStatus | null
  monitorView: MonitorView | null
  onMonitorView: (view: MonitorView) => void
  onConfigure: () => void
  onOpenWidget: () => void
}): React.JSX.Element {
  const [commandBusy, setCommandBusy] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const authenticated =
    monitorView?.readiness.authenticated ?? auth?.state === 'AUTHENTICATED'
  const configured =
    monitorView?.readiness.captureConfigured ?? captureStatus?.configured === true
  const monitorState = monitorView?.state ?? null
  const active =
    monitorState !== null &&
    ['PREFLIGHT', 'STARTING', 'READY', 'STOPPING'].includes(monitorState)
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
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active, monitorView?.startedAt])

  const runCommand = async (command: 'start' | 'stop'): Promise<void> => {
    setCommandBusy(true)
    setCommandError(null)
    try {
      onMonitorView(
        command === 'start'
          ? await window.crTools.startMonitor()
          : await window.crTools.stopMonitor(),
      )
    } catch {
      setCommandError(
        command === 'start'
          ? 'Не удалось запустить мониторинг. Проверьте источник и повторите.'
          : 'Не удалось остановить мониторинг. Повторите операцию.',
      )
    } finally {
      setCommandBusy(false)
    }
  }

  const updatePreference = async (patch: Partial<MonitorPreferences>): Promise<void> => {
    if (monitorView === null) return
    setCommandBusy(true)
    setCommandError(null)
    try {
      const preferences = await window.crTools.updateMonitorPreferences({
        ...monitorView.preferences,
        ...patch,
      })
      onMonitorView({ ...monitorView, preferences })
    } catch {
      setCommandError('Не удалось сохранить режим мониторинга.')
    } finally {
      setCommandBusy(false)
    }
  }

  const sourceAvailable = monitorView?.readiness.sourceAvailable ?? null
  const readiness = [
    {
      label: 'Учётная запись',
      state: authenticated ? 'ready' : 'warning',
      detail: authenticated
        ? (auth?.user?.username ?? 'Вход выполнен')
        : 'Требуется вход',
    },
    {
      label: 'Конфигурация захвата',
      state: configured ? 'ready' : 'warning',
      detail: configured
        ? (captureStatus?.sourceLabel ?? 'Настроена')
        : 'Выберите источник',
    },
    {
      label: 'Доступность источника',
      state: !configured
        ? 'warning'
        : sourceAvailable === null
          ? 'loading'
          : sourceAvailable
            ? 'ready'
            : 'warning',
      detail: !configured
        ? 'Сначала настройте захват'
        : sourceAvailable === null
          ? 'Проверим при запуске'
          : sourceAvailable
            ? 'Источник доступен'
            : 'Источник не найден',
    },
  ] as const
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
              <Alert
                title="Не удалось продолжить"
                details={<code>{monitorView.error.code}</code>}
              >
                {publicErrorMessage(monitorView.error.code, monitorView.error.message)}
              </Alert>
            )}
            {commandError !== null && <Alert>{commandError}</Alert>}
            <div className="monitor-actions">
              <Button
                className={active ? 'stop-button monitor-primary' : 'monitor-primary'}
                variant={active ? 'danger' : 'primary'}
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
                {commandBusy ? 'Выполняем...' : hero.action}
              </Button>
            </div>
          </div>
          <div className="monitor-hero-context">
            {sessionDuration !== null && active && (
              <div className="session-time" aria-live="off">
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
                  ['pol', 'Путь легенд'],
                  ['gt', 'Турнир'],
                ]}
                value={monitorView?.preferences.deckMode ?? 'pol'}
                disabled={active || commandBusy || monitorView === null}
                onChange={(deckMode) => void updatePreference({ deckMode })}
              />
            </div>
          </div>
        </section>

        <SessionStats view={monitorView} />
        <Section
          className="results-panel"
          eyebrow="ИСТОРИЯ СЕССИИ"
          title="Последние результаты"
          actions={
            <div className="results-tools">
              <span className="result-count">
                {monitorView?.results.length ?? 0} из 20
              </span>
              {monitorView?.results.some((result) => result.kind === 'player_found') && (
                <Button className="result-widget-action" onClick={onOpenWidget}>
                  <ExternalLink aria-hidden="true" size={14} />
                  Открыть виджет
                </Button>
              )}
            </div>
          }
        >
          {monitorView === null ? (
            <div
              className="results-loading"
              aria-label="Загрузка результатов"
              role="status"
            >
              <span />
              <span />
              <span />
            </div>
          ) : monitorView.results.length === 0 ? (
            <div className="results-empty">
              <UserSearch aria-hidden="true" size={24} />
              <strong>Результатов пока нет</strong>
              <span>
                Запустите мониторинг. Найденные игроки и ошибки распознавания появятся
                здесь.
              </span>
            </div>
          ) : (
            <div className="result-list">
              {monitorView.results.map((result) => (
                <ResultCard key={result.id} result={result} />
              ))}
            </div>
          )}
        </Section>
      </div>

      <aside className="home-context" aria-label="Контекст мониторинга">
        <Section
          className="readiness-panel"
          eyebrow="ПОДГОТОВКА"
          title="Готовность к запуску"
          actions={
            <span className="readiness-total">
              {readiness.filter((item) => item.state === 'ready').length}/
              {readiness.length}
            </span>
          }
        >
          <div className="readiness-list">
            {readiness.map((item) => (
              <div className="readiness-row" key={item.label} data-state={item.state}>
                <span className="readiness-marker" aria-hidden="true" />
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <section className="context-section current-configuration">
          <span className="eyebrow">ТЕКУЩАЯ КОНФИГУРАЦИЯ</span>
          <dl>
            <div>
              <dt>Источник</dt>
              <dd title={captureStatus?.sourceLabel ?? undefined}>
                {captureStatus?.sourceLabel ?? 'Не выбран'}
              </dd>
            </div>
            <div>
              <dt>Поиск</dt>
              <dd>
                {monitorView?.preferences.searchMode === 'precise' ? 'Точный' : 'Быстрый'}
              </dd>
            </div>
            <div>
              <dt>Колоды</dt>
              <dd>
                {monitorView?.preferences.deckMode === 'gt' ? 'Турнир' : 'Путь легенд'}
              </dd>
            </div>
          </dl>
          <Button className="compact-link" variant="text" onClick={onConfigure}>
            Изменить захват
            <ChevronRight aria-hidden="true" size={14} />
          </Button>
        </section>

        <section className="context-section home-guidance">
          <span className="eyebrow">КАК ЭТО РАБОТАЕТ</span>
          <p>
            Мониторинг ждёт игровой триггер, распознаёт соперника и сохраняет до 20
            результатов текущей сессии.
          </p>
          <div>
            <AlertCircle aria-hidden="true" size={16} />
            Настройки режима можно менять только между сессиями.
          </div>
        </section>
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
      kicker: 'Получаем данные',
      title: 'Проверяем готовность системы',
      description: 'Загружаем конфигурацию захвата и состояние мониторинга.',
      action: 'Загрузка...',
      tone: 'loading',
    }
  }
  if (view.state === 'PREFLIGHT' || view.state === 'STARTING') {
    return {
      kicker: 'Запуск',
      title: 'Проверяем источник',
      description: 'Подготавливаем захват и локальный мониторинг соперника.',
      action: 'Остановить мониторинг',
      tone: 'warning',
    }
  }
  if (view.state === 'READY') {
    return {
      kicker: 'Активная сессия',
      title: 'Мониторинг активен',
      description: 'Ожидаем игровой триггер и следующий результат распознавания.',
      action: 'Остановить мониторинг',
      tone: 'success',
    }
  }
  if (view.state === 'STOPPING') {
    return {
      kicker: 'Завершение сессии',
      title: 'Останавливаем мониторинг',
      description: 'Завершаем локальный процесс и текущие операции.',
      action: 'Останавливаем...',
      tone: 'warning',
    }
  }
  if (!configured) {
    return {
      kicker: 'Требуется настройка',
      title: 'Выберите источник захвата',
      description: 'Укажите окно Clash Royale или монитор перед запуском распознавания.',
      action: 'Выбрать источник',
      tone: 'warning',
    }
  }
  if (sourceUnavailable) {
    return {
      kicker: 'Источник недоступен',
      title: 'Окно захвата не найдено',
      description: 'Откройте Clash Royale или выберите другой доступный источник.',
      action: 'Выбрать другой источник',
      tone: 'warning',
    }
  }
  if (view.state === 'FAILED') {
    return {
      kicker: 'Требуется внимание',
      title: 'Мониторинг остановлен',
      description:
        view.error?.message ?? 'Проверьте состояние системы и повторите запуск.',
      action: 'Повторить запуск',
      tone: 'danger',
    }
  }
  return {
    kicker: 'Готово к работе',
    title: 'Запустите мониторинг',
    description: 'Источник настроен. Система готова искать следующего соперника.',
    action: 'Запустить мониторинг',
    tone: 'success',
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
  const values: readonly [string, number | undefined][] = [
    ['Найдены', stats?.playersFound],
    ['Не найдены', stats?.playersNotFound],
    ['Не распознано', stats?.recognitionFailures],
    ['Ошибки сервиса', stats?.serviceErrors],
    ['Пропущено', stats?.droppedActions],
  ]
  return (
    <section
      className="stats-strip"
      aria-label="Статистика сессии"
      aria-busy={view === null}
    >
      {values.map(([label, value]) => (
        <div key={label} data-loading={value === undefined}>
          <strong>{value ?? '...'}</strong>
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
  const detail =
    result.kind === 'player_found'
      ? [result.player.tag, result.player.rating, result.player.clan]
          .filter((value) => value !== null)
          .join(' · ') || 'Профиль найден'
      : result.message
  const searchMode = result.searchMode === 'precise' ? 'Точный поиск' : 'Быстрый поиск'
  const deckMode = result.deckMode === 'gt' ? 'Турнир' : 'Путь легенд'
  return (
    <article className="result-card" data-kind={result.kind}>
      <div className="result-status" aria-hidden="true" />
      <div>
        <div className="result-title">
          <strong>{resultTitle(result)}</strong>
          <time dateTime={result.timestamp}>
            {new Date(result.timestamp).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        <p>{detail}</p>
        <span>
          {searchMode} · {deckMode}
          {result.searchedNickname !== null
            ? ` · запрос: ${result.searchedNickname}`
            : ''}
        </span>
        {result.kind === 'player_found' && result.decks.length > 0 && (
          <small>{formatDeckCount(result.decks.length)} сохранено для виджета</small>
        )}
      </div>
    </article>
  )
}
