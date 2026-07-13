import {
  AlertTriangle,
  Clipboard,
  ExternalLink,
  RefreshCw,
  Settings2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { hasStreamerRole, type AuthView } from '../../../shared/models/auth'
import type {
  OverlaySettings,
  PredictionPreferences,
  StreamerView,
  StreamTitleSettings,
} from '../../../shared/models/streamer'
import '../styles/streamer.css'

type Tab = 'overview' | 'predictions' | 'title' | 'obs'

export function StreamerPage({ auth }: { auth: AuthView | null }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const [view, setView] = useState<StreamerView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.crTools
      .setStreamerSectionActive(true)
      .then((value) => {
        if (active) setView(value)
      })
      .catch(() => {
        if (active) setError('Не удалось открыть рабочее пространство стримера.')
      })
    void window.crTools
      .refreshStreamer()
      .then((value) => active && setView(value))
      .catch(() => undefined)
    return () => {
      active = false
      void window.crTools.setStreamerSectionActive(false).catch(() => undefined)
    }
  }, [])

  const run = async (
    name: string,
    operation: () => Promise<StreamerView>,
  ): Promise<void> => {
    setBusy(name)
    setError(null)
    try {
      setView(await operation())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Операция не выполнена.')
    } finally {
      setBusy(null)
    }
  }

  if (!hasStreamerRole(auth)) {
    return (
      <section className="streamer-denied">
        <AlertTriangle aria-hidden="true" size={22} />
        <span className="eyebrow">ДОСТУП ОГРАНИЧЕН</span>
        <h2>Нужна роль стримера</h2>
        <p>
          Управление трансляцией доступно только профилям с ролью streamer. Проверьте
          активный аккаунт и войдите снова.
        </p>
      </section>
    )
  }
  if (view === null) {
    return (
      <section className="streamer-state" aria-live="polite">
        <RefreshCw
          className={busy !== null ? 'is-spinning' : undefined}
          aria-hidden="true"
          size={22}
        />
        <span className="eyebrow">
          {error === null ? 'СИНХРОНИЗАЦИЯ' : 'НЕТ СОЕДИНЕНИЯ'}
        </span>
        <h2>
          {error === null
            ? 'Загружаем состояние трансляции'
            : 'Рабочее пространство недоступно'}
        </h2>
        <p>{error ?? 'Получаем настройки Twitch, автоматизации и OBS.'}</p>
        {error !== null && (
          <button
            className="primary-button"
            disabled={busy !== null}
            type="button"
            onClick={() => void run('refresh', window.crTools.refreshStreamer)}
          >
            Повторить
          </button>
        )}
      </section>
    )
  }

  const tabs: readonly [Tab, string][] = [
    ['overview', 'Обзор'],
    ['predictions', 'Twitch и прогнозы'],
    ['title', 'Название стрима'],
    ['obs', 'OBS'],
  ]
  return (
    <div className="streamer-workspace" aria-busy={busy !== null}>
      <div className="streamer-toolbar">
        <div className="streamer-tabs" role="tablist" aria-label="Разделы стримера">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`streamer-tab-${id}`}
              aria-controls={`streamer-panel-${id}`}
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="streamer-sync">
          <span data-state={view.refresh.state}>
            {busy === 'refresh' ? 'Обновление данных' : refreshLabel(view)}
          </span>
          <button
            className="secondary-button"
            disabled={busy !== null}
            type="button"
            onClick={() => void run('refresh', window.crTools.refreshStreamer)}
          >
            <RefreshCw
              className={busy === 'refresh' ? 'is-spinning' : undefined}
              size={15}
              aria-hidden="true"
            />
            Обновить
          </button>
        </div>
      </div>
      <div className="streamer-notices">
        {error !== null && (
          <div className="inline-alert" role="alert">
            <AlertTriangle aria-hidden="true" size={16} />
            <span>{error}</span>
          </div>
        )}
        {view.refresh.errors.length > 0 && (
          <div className="streamer-partial" role="status">
            <AlertTriangle aria-hidden="true" size={16} />
            <span>
              Получены частичные данные. Недоступные разделы:{' '}
              <strong>
                {view.refresh.errors.map((item) => item.section).join(', ')}
              </strong>
            </span>
          </div>
        )}
      </div>
      <section
        className="streamer-tab-content"
        id={`streamer-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`streamer-tab-${tab}`}
      >
        {tab === 'overview' && <Overview view={view} busy={busy} run={run} />}
        {tab === 'predictions' && (
          <Predictions
            key={JSON.stringify(view.predictions.settings)}
            view={view}
            busy={busy}
            run={run}
          />
        )}
        {tab === 'title' && (
          <StreamTitle
            key={JSON.stringify(view.title.settings)}
            view={view}
            busy={busy}
            run={run}
          />
        )}
        {tab === 'obs' && (
          <Obs
            key={JSON.stringify(view.overlay.settings)}
            view={view}
            busy={busy}
            run={run}
          />
        )}
      </section>
    </div>
  )
}

type Runner = (name: string, operation: () => Promise<StreamerView>) => Promise<void>

function refreshLabel(view: StreamerView): string {
  if (view.refresh.refreshedAt === null) return 'Еще не синхронизировано'
  const refreshedAt = new Date(view.refresh.refreshedAt)
  if (Number.isNaN(refreshedAt.getTime())) return 'Данные синхронизированы'
  return `Обновлено в ${refreshedAt.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

function previewTargetLabel(settings: OverlaySettings): string {
  if (settings.previewTarget === 'stats') return 'Только статистика'
  if (settings.previewTarget === 'opponent') return 'Только соперник'
  return 'Оба виджета'
}

function Overview({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: Runner
}): React.JSX.Element {
  const requirements = view.predictions.requirements
  const readyCount = Object.values(requirements).filter(Boolean).length
  return (
    <div className="streamer-overview-layout">
      <section className="streamer-panel streamer-overview-primary">
        <div className="streamer-section-heading">
          <div>
            <span className="eyebrow">ЦЕНТР УПРАВЛЕНИЯ</span>
            <h2>
              {view.twitch.connected
                ? `Twitch @${view.twitch.username ?? 'connected'}`
                : 'Twitch не подключен'}
            </h2>
          </div>
          <StatusIndicator
            label={view.twitch.connected ? 'Канал подключен' : 'Требуется подключение'}
            tone={view.twitch.connected ? 'success' : 'warning'}
          />
        </div>
        <p className="streamer-lead">
          Сводка серверной автоматизации, которая работает во время трансляции.
        </p>
        <div className="streamer-metrics">
          <Metric
            label="Прогнозы"
            value={view.predictions.active ? 'Активны' : 'Остановлены'}
            tone={view.predictions.active ? 'success' : 'neutral'}
          />
          <Metric
            label="Название"
            value={view.title.settings.enabled ? 'Включено' : 'Выключено'}
            tone={view.title.settings.enabled ? 'success' : 'neutral'}
          />
          <Metric
            label="OBS"
            value={view.overlay.settings.enabled ? 'Включен' : 'Выключен'}
            tone={view.overlay.settings.enabled ? 'success' : 'neutral'}
          />
          <Metric
            label="Колоды в чат"
            value={view.deckSharing.enabled ? 'Включены' : 'Выключены'}
            tone={view.deckSharing.enabled ? 'success' : 'neutral'}
          />
        </div>
        <div className="streamer-operation-board">
          <div>
            <span>Текущий прогноз</span>
            <strong>
              {view.predictions.statistics.activeTitle ?? 'Нет активного прогноза'}
            </strong>
            <small>Состояние автоматики: {view.predictions.state}</small>
          </div>
          <div>
            <span>Название канала</span>
            <strong>{view.title.previewTitle || 'Предпросмотр пока недоступен'}</strong>
            <small>
              {view.title.twitchOnline ? 'Канал сейчас онлайн' : 'Канал сейчас офлайн'}
            </small>
          </div>
        </div>
      </section>
      <aside className="streamer-context-stack" aria-label="Контекст трансляции">
        <section className="streamer-panel streamer-readiness-panel">
          <div className="streamer-section-heading compact">
            <div>
              <span className="eyebrow">ПРЕДВАРИТЕЛЬНАЯ ПРОВЕРКА</span>
              <h2>Готовность</h2>
            </div>
            <strong className="readiness-count">{readyCount}/4</strong>
          </div>
          <div className="requirement-list">
            <Requirement label="Twitch" ready={requirements.twitchConnected} />
            <Requirement
              label="Основной захват"
              ready={requirements.mainMonitorConfigured}
            />
            <Requirement
              label="Монитор запущен"
              ready={requirements.mainMonitorRunning}
            />
            <Requirement label="Зоны результата" ready={requirements.resultConfigured} />
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={busy !== null}
            onClick={() => void run('setup', window.crTools.startStreamerResultSetup)}
          >
            <Settings2 aria-hidden="true" size={15} />
            Настроить зоны
          </button>
        </section>
        <section className="streamer-panel streamer-deck-panel">
          <span className="eyebrow">TWITCH CHAT</span>
          <h2>Публикация колод</h2>
          <p>Отправляет распознанную колоду в чат подключенного канала.</p>
          <Toggle
            label="Отправлять колоды"
            checked={view.deckSharing.enabled}
            disabled={busy !== null || !view.twitch.connected}
            onChange={(enabled) =>
              void run('deck', () => window.crTools.setDeckSharing(enabled))
            }
          />
          {!view.twitch.connected && (
            <small className="streamer-control-hint">Сначала подключите Twitch.</small>
          )}
        </section>
      </aside>
    </div>
  )
}

function Predictions({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: Runner
}): React.JSX.Element {
  const [settings, setSettings] = useState(view.predictions.settings)
  const requirements = view.predictions.requirements
  const ready =
    requirements.twitchConnected &&
    requirements.mainMonitorConfigured &&
    requirements.resultConfigured
  return (
    <div className="streamer-context-layout prediction-layout">
      <section className="streamer-panel streamer-context-main prediction-control">
        <div className="streamer-section-heading">
          <div>
            <span className="eyebrow">АВТОМАТИЗАЦИЯ</span>
            <h2>Прогнозы канала</h2>
          </div>
          <StatusIndicator
            label={view.predictions.active ? 'Выполняются' : 'Остановлены'}
            tone={view.predictions.active ? 'success' : 'neutral'}
          />
        </div>
        <p className="streamer-lead">
          {view.predictions.active
            ? `Текущий статус: ${view.predictions.state}`
            : 'Настройте сценарий и запустите автоматическое создание прогнозов.'}
        </p>
        <div className="streamer-metrics">
          <Metric label="Всего" value={String(view.predictions.statistics.total)} />
          <Metric
            label="Успешно"
            value={String(view.predictions.statistics.successful)}
          />
          <Metric
            label="Доля побед"
            value={`${view.predictions.statistics.successRate}%`}
          />
          <Metric
            label="Серия"
            value={String(view.predictions.statistics.currentWinStreak)}
          />
        </div>
        <div className="prediction-current" data-active={view.predictions.active}>
          <span>Текущий прогноз</span>
          <strong>
            {view.predictions.statistics.activeTitle ?? 'Активного прогноза сейчас нет'}
          </strong>
        </div>
        <PredictionFields
          value={settings}
          onChange={setSettings}
          disabled={busy !== null || view.predictions.active}
        />
        <div className="streamer-action-row">
          {view.predictions.active ? (
            <button
              className="danger-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void run('stop-predictions', window.crTools.stopPredictions)}
            >
              Остановить прогнозы
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null || !ready}
              onClick={() =>
                void run('start-predictions', () =>
                  window.crTools.startPredictions(settings),
                )
              }
            >
              Запустить прогнозы
            </button>
          )}
          {!ready && (
            <span className="streamer-control-hint">
              Завершите обязательные пункты проверки справа.
            </span>
          )}
        </div>
      </section>
      <aside className="streamer-context-stack" aria-label="Подключение и готовность">
        <section className="streamer-panel twitch-connection-panel">
          <div className="streamer-section-heading compact">
            <div>
              <span className="eyebrow">TWITCH</span>
              <h2>Подключение канала</h2>
            </div>
            <StatusIndicator
              label={view.twitch.connected ? 'Подключен' : 'Не подключен'}
              tone={view.twitch.connected ? 'success' : 'warning'}
            />
          </div>
          <p>
            {view.twitch.connected
              ? `Команды отправляются в канал @${view.twitch.username ?? 'unknown'}.`
              : view.twitch.polling
                ? 'Ожидаем завершения авторизации в системном браузере.'
                : 'Подключите канал, чтобы создавать прогнозы.'}
          </p>
          {view.twitch.connected ? (
            <button
              className="danger-button"
              disabled={busy !== null}
              type="button"
              onClick={() => {
                if (window.confirm('Отключить Twitch и отозвать серверный токен?'))
                  void run('disconnect', () =>
                    window.crTools.disconnectTwitch({ confirmed: true }),
                  )
              }}
            >
              Отключить Twitch
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={busy !== null}
              type="button"
              onClick={() => void run('connect', window.crTools.connectTwitch)}
            >
              <ExternalLink aria-hidden="true" size={15} />
              Подключить Twitch
            </button>
          )}
        </section>
        <section className="streamer-panel streamer-readiness-panel">
          <span className="eyebrow">УСЛОВИЯ ЗАПУСКА</span>
          <h2>Проверка системы</h2>
          <div className="requirement-list">
            <Requirement label="Twitch" ready={requirements.twitchConnected} />
            <Requirement
              label="Основной захват"
              ready={requirements.mainMonitorConfigured}
            />
            <Requirement
              label="Монитор запущен"
              ready={requirements.mainMonitorRunning}
            />
            <Requirement label="Зоны результата" ready={requirements.resultConfigured} />
          </div>
        </section>
      </aside>
    </div>
  )
}

function PredictionFields({
  value,
  onChange,
  disabled,
}: {
  value: PredictionPreferences
  onChange: (value: PredictionPreferences) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <div className="streamer-settings-block prediction-settings">
      <div className="streamer-form prediction-primary-form">
        <label>
          Сценарий прогноза
          <select
            disabled={disabled}
            value={value.predictionType}
            onChange={(event) =>
              onChange({
                ...value,
                predictionType: event.target
                  .value as PredictionPreferences['predictionType'],
              })
            }
          >
            <option value="win_lose">Победа / поражение</option>
            <option value="win_streak">Серия побед</option>
            <option value="mix">Смешанный</option>
          </select>
        </label>
        <NumberField
          label="Окно голосования, сек"
          value={value.predictionWindow}
          min={30}
          max={1800}
          disabled={disabled}
          onChange={(predictionWindow) => onChange({ ...value, predictionWindow })}
        />
      </div>
      <div className="streamer-switch-grid single-switch">
        <Toggle
          label="Автоматически создавать следующий прогноз"
          checked={value.autoCreateNext}
          disabled={disabled}
          onChange={(autoCreateNext) => onChange({ ...value, autoCreateNext })}
        />
      </div>
      <details className="streamer-disclosure">
        <summary>
          <span>Расширенные интервалы</span>
          <small>Серия побед и пауза между прогнозами</small>
        </summary>
        <div className="streamer-form compact-form">
          <NumberField
            label="Побед в целевой серии"
            value={value.winStreakCount}
            min={2}
            max={10}
            disabled={disabled}
            onChange={(winStreakCount) => onChange({ ...value, winStreakCount })}
          />
          <NumberField
            label="Пауза между прогнозами, сек"
            value={value.delayBetweenPredictions}
            min={1}
            max={60}
            disabled={disabled}
            onChange={(delayBetweenPredictions) =>
              onChange({ ...value, delayBetweenPredictions })
            }
          />
        </div>
      </details>
    </div>
  )
}

function StreamTitle({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: Runner
}): React.JSX.Element {
  const [settings, setSettings] = useState(view.title.settings)
  const [tag, setTag] = useState('')
  const [alias, setAlias] = useState('')
  return (
    <div className="streamer-context-layout title-layout">
      <section className="streamer-panel streamer-context-main title-control-panel">
        <div className="streamer-section-heading">
          <div>
            <span className="eyebrow">НАЗВАНИЕ КАНАЛА</span>
            <h2>Автоматическое название</h2>
          </div>
          <Toggle
            label="Автоматизация"
            checked={settings.enabled}
            disabled={busy !== null || !view.twitch.connected}
            onChange={(enabled) =>
              void run('title-enabled', () =>
                window.crTools.setStreamTitleEnabled(enabled),
              )
            }
          />
        </div>
        <div className="title-runtime-strip">
          <StatusIndicator
            label={view.title.twitchOnline ? 'Канал онлайн' : 'Канал офлайн'}
            tone={view.title.twitchOnline ? 'success' : 'neutral'}
          />
          <StatusIndicator
            label={settings.paused ? 'Обновления на паузе' : 'Обновления разрешены'}
            tone={settings.paused ? 'warning' : 'success'}
          />
        </div>
        <span className="field-caption">Предпросмотр названия</span>
        <div className="title-preview">
          {view.title.previewTitle || 'Предпросмотр появится после добавления аккаунта'}
        </div>
        <TitleFields value={settings} onChange={setSettings} disabled={busy !== null} />
        <div className="streamer-action-row title-primary-actions">
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('title-save', () => window.crTools.updateStreamTitle(settings))
            }
          >
            Сохранить название
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('title-pause', () =>
                window.crTools.setStreamTitlePaused(!settings.paused),
              )
            }
          >
            {settings.paused ? 'Продолжить' : 'Пауза'}
          </button>
        </div>
        <details className="streamer-disclosure title-session-actions">
          <summary>
            <span>Действия с текущей сессией</span>
            <small>Сброс, отмена результата и восстановление названия</small>
          </summary>
          <div className="button-row">
            <ConfirmedButton
              label="Сбросить W/L"
              disabled={busy !== null}
              prompt="Сбросить статистику текущей сессии?"
              action={() =>
                run('title-reset', () =>
                  window.crTools.resetStreamTitle({ confirmed: true }),
                )
              }
            />
            <ConfirmedButton
              label="Отменить результат"
              disabled={busy !== null}
              prompt="Отменить последний результат?"
              action={() =>
                run('title-undo', () =>
                  window.crTools.undoStreamTitle({ confirmed: true }),
                )
              }
            />
            <ConfirmedButton
              label="Вернуть исходное название"
              disabled={busy !== null}
              prompt="Восстановить исходное название Twitch?"
              action={() =>
                run('title-restore', () =>
                  window.crTools.restoreStreamTitle({ confirmed: true }),
                )
              }
            />
          </div>
        </details>
      </section>
      <aside className="streamer-context-stack" aria-label="Аккаунты и сессия">
        <section className="streamer-panel accounts-panel">
          <div className="streamer-section-heading compact">
            <div>
              <span className="eyebrow">CLASH ROYALE</span>
              <h2>Аккаунты</h2>
            </div>
            <span className="context-count">{view.title.accounts.length}/4</span>
          </div>
          <div className="account-add">
            <label>
              Тег аккаунта
              <input
                value={tag}
                maxLength={20}
                placeholder="#TAG"
                onChange={(event) => setTag(event.target.value)}
              />
            </label>
            <label>
              Отображаемое имя
              <input
                value={alias}
                maxLength={100}
                placeholder="Основной"
                onChange={(event) => setAlias(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              disabled={busy !== null || tag.trim().length < 2}
              type="button"
              onClick={() =>
                void run('account-add', () =>
                  window.crTools.addStreamTitleAccount({ tag, alias }),
                )
              }
            >
              Добавить аккаунт
            </button>
          </div>
          {view.title.accounts.length === 0 ? (
            <div className="streamer-empty compact-empty">
              <strong>Аккаунтов пока нет</strong>
              <span>Добавьте тег, чтобы сформировать название.</span>
            </div>
          ) : (
            <div className="account-list">
              {view.title.accounts.map((account) => (
                <div key={account.tag}>
                  <span>
                    <strong>{account.alias || account.name || account.tag}</strong>
                    <small>
                      {account.tag} ·{' '}
                      {account.currentRank === null
                        ? 'место ?'
                        : `#${account.currentRank}`}{' '}
                      · {account.currentElo ?? '?'} ELO
                    </small>
                  </span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('account-remove', () =>
                        window.crTools.removeStreamTitleAccount(account.tag),
                      )
                    }
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="streamer-panel title-session-panel">
          <span className="eyebrow">ТЕКУЩАЯ СЕССИЯ</span>
          <h2>Результат эфира</h2>
          {view.title.session === null ? (
            <div className="streamer-empty compact-empty">
              <strong>Сессия еще не началась</strong>
              <span>Статистика появится после первого результата.</span>
            </div>
          ) : (
            <div className="session-score">
              <div>
                <span>Победы</span>
                <strong>{view.title.session.totalWins}</strong>
              </div>
              <div>
                <span>Поражения</span>
                <strong>{view.title.session.totalLosses}</strong>
              </div>
              <small>
                Активный аккаунт: {view.title.session.activeAccountTag ?? 'не выбран'}
              </small>
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}

function TitleFields({
  value,
  onChange,
  disabled,
}: {
  value: StreamTitleSettings
  onChange: (value: StreamTitleSettings) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <div className="streamer-settings-block title-settings">
      <div className="streamer-form title-primary-form">
        <label className="form-wide">
          Шаблон префикса
          <input
            disabled={disabled}
            maxLength={200}
            value={value.prefixTemplate}
            onChange={(event) =>
              onChange({ ...value, prefixTemplate: event.target.value })
            }
          />
        </label>
        <label>
          Счет W/L
          <select
            disabled={disabled}
            value={value.wlMode}
            onChange={(event) =>
              onChange({
                ...value,
                wlMode: event.target.value as StreamTitleSettings['wlMode'],
              })
            }
          >
            <option value="active">Текущий аккаунт</option>
            <option value="total">Все аккаунты</option>
          </select>
        </label>
        <label>
          Выбор аккаунта
          <select
            disabled={disabled}
            value={value.accountDisplayMode}
            onChange={(event) =>
              onChange({
                ...value,
                accountDisplayMode: event.target
                  .value as StreamTitleSettings['accountDisplayMode'],
              })
            }
          >
            <option value="last_active">Последний активный</option>
            <option value="manual">Выбрать вручную</option>
            <option value="best_elo">Лучший ELO</option>
            <option value="multiple">Несколько аккаунтов</option>
          </select>
        </label>
        {value.accountDisplayMode === 'manual' && (
          <label>
            Тег выбранного аккаунта
            <input
              disabled={disabled}
              maxLength={20}
              value={value.manualAccountTag}
              onChange={(event) =>
                onChange({ ...value, manualAccountTag: event.target.value })
              }
            />
          </label>
        )}
        {value.accountDisplayMode === 'multiple' && (
          <NumberField
            label="Максимум аккаунтов"
            value={value.maxAccounts}
            min={1}
            max={4}
            disabled={disabled}
            onChange={(maxAccounts) => onChange({ ...value, maxAccounts })}
          />
        )}
      </div>
      <span className="field-caption">Данные в названии</span>
      <div className="streamer-switch-grid title-switches">
        {(
          [
            ['includeRank', 'Место в рейтинге'],
            ['includeElo', 'ELO'],
            ['includeWl', 'Победы / поражения'],
            ['includeDelta', 'Изменение рейтинга'],
          ] as const
        ).map(([key, label]) => (
          <Toggle
            key={key}
            label={label}
            checked={value[key]}
            disabled={disabled}
            onChange={(checked) => onChange({ ...value, [key]: checked })}
          />
        ))}
      </div>
      <details className="streamer-disclosure">
        <summary>
          <span>Дополнительные правила</span>
          <small>Тип боев и поведение после завершения эфира</small>
        </summary>
        <div className="streamer-form compact-form">
          <label>
            Учитывать бои
            <select
              disabled={disabled}
              value={value.battleMode}
              onChange={(event) =>
                onChange({
                  ...value,
                  battleMode: event.target.value as StreamTitleSettings['battleMode'],
                })
              }
            >
              <option value="pathOfLegend">Только Path of Legends</option>
              <option value="all">Все бои</option>
            </select>
          </label>
          <Toggle
            label="Восстановить название после офлайна"
            checked={value.restoreTitleOnOffline}
            disabled={disabled}
            onChange={(restoreTitleOnOffline) =>
              onChange({ ...value, restoreTitleOnOffline })
            }
          />
        </div>
      </details>
    </div>
  )
}

function Obs({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: Runner
}): React.JSX.Element {
  const [settings, setSettings] = useState(view.overlay.settings)
  return (
    <div className="obs-layout">
      <div className="obs-main-column">
        <section className="streamer-panel obs-control-panel">
          <div className="streamer-section-heading">
            <div>
              <span className="eyebrow">OBS BROWSER SOURCES</span>
              <h2>Адаптивные оверлеи</h2>
            </div>
            <Toggle
              label="Оверлеи"
              checked={settings.enabled}
              disabled={busy !== null}
              onChange={(enabled) => setSettings({ ...settings, enabled })}
            />
          </div>
          <p className="streamer-lead">
            Управление виджетами статистики и соперника для browser source в OBS.
          </p>
          {settings.previewMode && (
            <div className="preview-warning">
              <AlertTriangle aria-hidden="true" size={16} />
              <span>
                Режим предпросмотра меняет серверное поведение. Выключите его перед
                эфиром.
              </span>
            </div>
          )}
          <OverlayFields
            value={settings}
            onChange={setSettings}
            disabled={busy !== null}
          />
          <div className="streamer-action-row">
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run('overlay-save', () => window.crTools.updateOverlay(settings))
              }
            >
              Сохранить настройки OBS
            </button>
          </div>
        </section>
        <section className="streamer-panel obs-preview-panel">
          <div className="streamer-section-heading compact">
            <div>
              <span className="eyebrow">ЛОКАЛЬНЫЙ ПРЕДПРОСМОТР</span>
              <h2>Композиция без live token</h2>
            </div>
            <span className="preview-target-label">{previewTargetLabel(settings)}</span>
          </div>
          <div className="mock-preview-grid">
            <MockStats settings={settings} />
            <MockOpponent settings={settings} />
          </div>
        </section>
      </div>
      <aside className="streamer-context-stack obs-context" aria-label="Ссылки OBS">
        <section className="streamer-panel obs-urls-panel">
          <span className="eyebrow">ИСТОЧНИКИ</span>
          <h2>Ссылки OBS</h2>
          <p>Скопируйте URL и добавьте его в OBS как источник «Браузер».</p>
          <UrlRow
            label="Статистика стримера"
            available={view.overlay.urlsAvailable.stats}
            size={view.overlay.recommendedSizes.stats}
            copy={() => run('copy-stats', () => window.crTools.copyOverlayUrl('stats'))}
          />
          <UrlRow
            label="Соперник"
            available={view.overlay.urlsAvailable.opponent}
            size={view.overlay.recommendedSizes.opponent}
            copy={() =>
              run('copy-opponent', () => window.crTools.copyOverlayUrl('opponent'))
            }
          />
          <details className="streamer-disclosure token-disclosure">
            <summary>
              <span>Безопасность ссылок</span>
              <small>Замена токена доступа</small>
            </summary>
            <p>После замены текущие URL в OBS сразу перестанут работать.</p>
            <ConfirmedButton
              label="Сменить токен"
              disabled={busy !== null}
              prompt="Старые OBS URL сразу перестанут работать. Сменить токен?"
              action={() =>
                run('overlay-token', () =>
                  window.crTools.rotateOverlayToken({ confirmed: true }),
                )
              }
            />
          </details>
        </section>
        <section className="streamer-panel obs-status-panel">
          <span className="eyebrow">СОСТОЯНИЕ ВИДЖЕТОВ</span>
          <h2>Эфирный контур</h2>
          <div className="widget-status-list">
            <StatusIndicator
              label="Статистика стримера"
              tone={settings.streamerStatsEnabled ? 'success' : 'neutral'}
              value={settings.streamerStatsEnabled ? 'Включена' : 'Выключена'}
            />
            <StatusIndicator
              label="Карточка соперника"
              tone={settings.opponentEnabled ? 'success' : 'neutral'}
              value={settings.opponentEnabled ? 'Включена' : 'Выключена'}
            />
            <StatusIndicator
              label="Режим предпросмотра"
              tone={settings.previewMode ? 'warning' : 'success'}
              value={settings.previewMode ? 'Активен' : 'Выключен'}
            />
          </div>
        </section>
      </aside>
    </div>
  )
}

function OverlayFields({
  value,
  onChange,
  disabled,
}: {
  value: OverlaySettings
  onChange: (value: OverlaySettings) => void
  disabled: boolean
}): React.JSX.Element {
  const setNumber = (key: keyof OverlaySettings) => (next: number) =>
    onChange({ ...value, [key]: next })
  return (
    <div className="streamer-settings-block overlay-settings">
      <span className="field-caption">Активные виджеты</span>
      <div className="streamer-switch-grid overlay-switches">
        <Toggle
          label="Статистика стримера"
          checked={value.streamerStatsEnabled}
          disabled={disabled}
          onChange={(streamerStatsEnabled) =>
            onChange({ ...value, streamerStatsEnabled })
          }
        />
        <Toggle
          label="Карточка соперника"
          checked={value.opponentEnabled}
          disabled={disabled}
          onChange={(opponentEnabled) => onChange({ ...value, opponentEnabled })}
        />
        <Toggle
          label="Режим предпросмотра"
          checked={value.previewMode}
          disabled={disabled}
          onChange={(previewMode) => onChange({ ...value, previewMode })}
        />
      </div>
      <div className="streamer-form overlay-primary-form">
        <Select
          label="Предпросмотр"
          value={value.previewTarget}
          options={['stats', 'opponent', 'both']}
          disabled={disabled}
          onChange={(previewTarget) =>
            onChange({
              ...value,
              previewTarget: previewTarget as OverlaySettings['previewTarget'],
            })
          }
        />
        <Select
          label="Компоновка статистики"
          value={value.statsLayout}
          options={['compact', 'standard', 'detailed']}
          disabled={disabled}
          onChange={(statsLayout) =>
            onChange({
              ...value,
              statsLayout: statsLayout as OverlaySettings['statsLayout'],
            })
          }
        />
        <Select
          label="Компоновка соперника"
          value={value.opponentLayout}
          options={['compact', 'standard', 'detailed']}
          disabled={disabled}
          onChange={(opponentLayout) =>
            onChange({
              ...value,
              opponentLayout: opponentLayout as OverlaySettings['opponentLayout'],
            })
          }
        />
        <Select
          label="Аккаунт стримера"
          value={value.streamerAccountMode}
          options={['stream_title', 'manual']}
          disabled={disabled}
          onChange={(streamerAccountMode) =>
            onChange({
              ...value,
              streamerAccountMode:
                streamerAccountMode as OverlaySettings['streamerAccountMode'],
            })
          }
        />
        {value.streamerAccountMode === 'manual' && (
          <label>
            Тег аккаунта вручную
            <input
              disabled={disabled}
              maxLength={20}
              value={value.manualStreamerTag}
              onChange={(event) =>
                onChange({ ...value, manualStreamerTag: event.target.value })
              }
            />
          </label>
        )}
      </div>
      <details className="streamer-disclosure">
        <summary>
          <span>Оформление виджетов</span>
          <small>Шрифт и форма углов</small>
        </summary>
        <div className="streamer-form compact-form">
          <Select
            label="Стиль шрифта"
            value={value.widgetFontStyle}
            options={['gaming', 'clean', 'condensed']}
            disabled={disabled}
            onChange={(widgetFontStyle) =>
              onChange({
                ...value,
                widgetFontStyle: widgetFontStyle as OverlaySettings['widgetFontStyle'],
              })
            }
          />
          <Select
            label="Форма углов"
            value={value.widgetCornerStyle}
            options={['rounded', 'square', 'pill']}
            disabled={disabled}
            onChange={(widgetCornerStyle) =>
              onChange({
                ...value,
                widgetCornerStyle:
                  widgetCornerStyle as OverlaySettings['widgetCornerStyle'],
              })
            }
          />
        </div>
      </details>
      <details className="streamer-disclosure">
        <summary>
          <span>Тайминги и matchup</span>
          <small>Технические параметры обновления и переходов</small>
        </summary>
        <div className="streamer-switch-grid advanced-switches">
          <Toggle
            label="Второй слайд соперника"
            checked={value.opponentSecondSlideEnabled}
            disabled={disabled}
            onChange={(opponentSecondSlideEnabled) =>
              onChange({ ...value, opponentSecondSlideEnabled })
            }
          />
          <Toggle
            label="Статистика matchup"
            checked={value.matchupEnabled}
            disabled={disabled}
            onChange={(matchupEnabled) => onChange({ ...value, matchupEnabled })}
          />
        </div>
        <div className="streamer-form overlay-advanced-form">
          {(
            [
              ['recentLimit', 'Последних боев', 1, 10],
              ['opponentDisplaySeconds', 'Показ соперника, сек', 5, 120],
              ['opponentSlideSeconds', 'Второй слайд, сек', 3, 60],
              ['opponentTransitionMs', 'Переход соперника, мс', 100, 3000],
              ['statsMainSeconds', 'Основная статистика, сек', 5, 120],
              ['statsDeltaSeconds', 'Изменение рейтинга, сек', 2, 30],
              ['statsBetweenSeconds', 'Пауза статистики, сек', 0, 30],
              ['statsPollMs', 'Опрос статистики, мс', 500, 5000],
              ['statsTransitionMs', 'Переход статистики, мс', 100, 3000],
              ['matchupMinGames', 'Минимум боев matchup', 1, 100],
            ] as const
          ).map(([key, label, min, max]) => (
            <NumberField
              key={key}
              label={label}
              value={value[key]}
              min={min}
              max={max}
              disabled={disabled}
              onChange={setNumber(key)}
            />
          ))}
          <label className="form-wide">
            Пределы рейтинга matchup
            <input
              disabled={disabled}
              value={value.matchupRankLimits.join(', ')}
              onChange={(event) =>
                onChange({
                  ...value,
                  matchupRankLimits: event.target.value
                    .split(',')
                    .map(Number)
                    .filter(
                      (item): item is 100 | 200 | 500 | 1000 =>
                        item === 100 || item === 200 || item === 500 || item === 1000,
                    )
                    .slice(0, 4),
                })
              }
            />
          </label>
        </div>
      </details>
    </div>
  )
}

function MockStats({ settings }: { settings: OverlaySettings }): React.JSX.Element {
  return (
    <div
      className={`mock-widget mock-${settings.widgetCornerStyle} mock-${settings.widgetFontStyle}`}
      data-visible={
        settings.streamerStatsEnabled && settings.previewTarget !== 'opponent'
      }
    >
      <small>STREAM SESSION</small>
      <strong>12W - 7L</strong>
      <span>#284 · 1,942 ELO · +36</span>
    </div>
  )
}
function MockOpponent({ settings }: { settings: OverlaySettings }): React.JSX.Element {
  return (
    <div
      className={`mock-widget mock-opponent mock-${settings.widgetCornerStyle} mock-${settings.widgetFontStyle}`}
      data-visible={settings.opponentEnabled && settings.previewTarget !== 'stats'}
    >
      <small>OPPONENT</small>
      <strong>Example Player</strong>
      <span>H2H 8:5 · Matchup 54%</span>
      <div className="mock-cards">
        {['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((item) => (
          <i key={item}>{item}</i>
        ))}
      </div>
    </div>
  )
}
function UrlRow({
  label,
  available,
  size,
  copy,
}: {
  label: string
  available: boolean
  size: string
  copy: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="url-row" data-available={available}>
      <span>
        <strong>{label}</strong>
        <small>
          {size} · {available ? 'URL готов' : 'URL недоступен'}
        </small>
      </span>
      <button
        className="secondary-button"
        type="button"
        disabled={!available}
        onClick={() => void copy()}
      >
        <Clipboard aria-hidden="true" size={14} />
        Копировать
      </button>
    </div>
  )
}
function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'success' | 'warning'
}): React.JSX.Element {
  return (
    <div data-tone={tone}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  )
}
function StatusIndicator({
  label,
  tone,
  value,
}: {
  label: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  value?: string
}): React.JSX.Element {
  return (
    <div className="streamer-status" data-tone={tone}>
      <i aria-hidden="true" />
      <span>{label}</span>
      {value !== undefined && <strong>{value}</strong>}
    </div>
  )
}
function Requirement({
  label,
  ready,
}: {
  label: string
  ready: boolean
}): React.JSX.Element {
  return (
    <div data-ready={ready}>
      <i />
      <span>{label}</span>
      <strong>{ready ? 'готово' : 'нужно настроить'}</strong>
    </div>
  )
}
function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="streamer-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  )
}
function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <label>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  )
}
function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: readonly string[]
  disabled: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label>
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  )
}
function ConfirmedButton({
  label,
  disabled,
  prompt,
  action,
}: {
  label: string
  disabled: boolean
  prompt: string
  action: () => Promise<void>
}): React.JSX.Element {
  return (
    <button
      className="secondary-button"
      type="button"
      disabled={disabled}
      onClick={() => {
        if (window.confirm(prompt)) void action()
      }}
    >
      {label}
    </button>
  )
}
