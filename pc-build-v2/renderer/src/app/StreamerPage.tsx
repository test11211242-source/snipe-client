import { Clipboard, ExternalLink, RefreshCw, Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { hasStreamerRole, type AuthView } from '../../../shared/models/auth'
import type {
  OverlaySettings,
  PredictionPreferences,
  StreamerView,
  StreamTitleSettings,
} from '../../../shared/models/streamer'

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
        <span className="eyebrow">ROLE GATE</span>
        <h2>Нужна роль streamer</h2>
        <p>
          Сервер принимает команды управления только с JWT и буквальной ролью streamer.
        </p>
      </section>
    )
  }
  if (view === null)
    return <div className="settings-loading">Загрузка streamer status...</div>

  const tabs: readonly [Tab, string][] = [
    ['overview', 'Обзор'],
    ['predictions', 'Twitch и прогнозы'],
    ['title', 'Название стрима'],
    ['obs', 'OBS'],
  ]
  return (
    <div className="streamer-workspace">
      <div className="streamer-toolbar">
        <div className="streamer-tabs" role="tablist" aria-label="Разделы стримера">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="secondary-button"
          disabled={busy !== null}
          type="button"
          onClick={() => void run('refresh', window.crTools.refreshStreamer)}
        >
          <RefreshCw size={15} aria-hidden="true" /> Обновить
        </button>
      </div>
      {error !== null && (
        <div className="inline-alert" role="alert">
          {error}
        </div>
      )}
      {view.refresh.errors.length > 0 && (
        <div className="streamer-partial" role="status">
          Частичные данные: {view.refresh.errors.map((item) => item.section).join(', ')}
        </div>
      )}
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
    </div>
  )
}

type Runner = (name: string, operation: () => Promise<StreamerView>) => Promise<void>

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
  return (
    <div className="streamer-grid">
      <section className="streamer-panel streamer-hero">
        <span className="eyebrow">STREAM CONTROL</span>
        <h2>
          {view.twitch.connected
            ? `Twitch @${view.twitch.username ?? 'connected'}`
            : 'Twitch не подключен'}
        </h2>
        <p>
          Прогнозы, заголовок, deck sharing и OBS управляются сервером через основной
          процесс.
        </p>
        <div className="streamer-metrics">
          <Metric
            label="Прогнозы"
            value={
              view.predictions.active
                ? 'ACTIVE'
                : view.predictions.runtimeState.toUpperCase()
            }
          />
          <Metric label="Название" value={view.title.settings.enabled ? 'ON' : 'OFF'} />
          <Metric label="OBS" value={view.overlay.settings.enabled ? 'ON' : 'OFF'} />
          <Metric label="Deck sharing" value={view.deckSharing.enabled ? 'ON' : 'OFF'} />
        </div>
      </section>
      <section className="streamer-panel">
        <span className="eyebrow">PREDICTION PREFLIGHT</span>
        <h2>Готовность</h2>
        <div className="requirement-list">
          <Requirement label="Twitch" ready={requirements.twitchConnected} />
          <Requirement
            label="Основной захват"
            ready={requirements.mainMonitorConfigured}
          />
          <Requirement label="Монитор запущен" ready={requirements.mainMonitorRunning} />
          <Requirement label="Зоны результата" ready={requirements.resultConfigured} />
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy !== null}
          onClick={() => void run('setup', window.crTools.startStreamerResultSetup)}
        >
          <Settings2 size={15} /> Настроить зоны результата
        </button>
      </section>
      <section className="streamer-panel">
        <span className="eyebrow">TWITCH CHAT</span>
        <h2>Публикация колод</h2>
        <p>Автоматически отправляет найденную колоду в чат подключенного канала.</p>
        <Toggle
          label="Deck sharing"
          checked={view.deckSharing.enabled}
          disabled={busy !== null || !view.twitch.connected}
          onChange={(enabled) =>
            void run('deck', () => window.crTools.setDeckSharing(enabled))
          }
        />
      </section>
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
    <div className="streamer-grid">
      <section className="streamer-panel">
        <span className="eyebrow">TWITCH OAUTH</span>
        <h2>Подключение канала</h2>
        <p>
          {view.twitch.connected
            ? `Подключен @${view.twitch.username ?? 'unknown'}`
            : view.twitch.polling
              ? 'Ожидаем callback в системном браузере...'
              : 'Канал не подключен.'}
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
            <ExternalLink size={15} /> Открыть Twitch
          </button>
        )}
      </section>
      <section className="streamer-panel prediction-control">
        <span className="eyebrow">AUTOMATION</span>
        <h2>{view.predictions.state}</h2>
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
        <PredictionFields
          value={settings}
          onChange={setSettings}
          disabled={busy !== null || view.predictions.active}
        />
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
      </section>
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
    <div className="streamer-form compact-form">
      <label>
        Тип
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
        label="Окно, сек"
        value={value.predictionWindow}
        min={30}
        max={1800}
        disabled={disabled}
        onChange={(predictionWindow) => onChange({ ...value, predictionWindow })}
      />
      <NumberField
        label="Побед в серии"
        value={value.winStreakCount}
        min={2}
        max={10}
        disabled={disabled}
        onChange={(winStreakCount) => onChange({ ...value, winStreakCount })}
      />
      <NumberField
        label="Задержка, сек"
        value={value.delayBetweenPredictions}
        min={1}
        max={60}
        disabled={disabled}
        onChange={(delayBetweenPredictions) =>
          onChange({ ...value, delayBetweenPredictions })
        }
      />
      <Toggle
        label="Создавать следующий"
        checked={value.autoCreateNext}
        disabled={disabled}
        onChange={(autoCreateNext) => onChange({ ...value, autoCreateNext })}
      />
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
    <div className="streamer-grid title-grid">
      <section className="streamer-panel streamer-wide">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">SERVER TITLE</span>
            <h2>Автоматическое название</h2>
          </div>
          <Toggle
            label="Включено"
            checked={settings.enabled}
            disabled={busy !== null || !view.twitch.connected}
            onChange={(enabled) =>
              void run('title-enabled', () =>
                window.crTools.setStreamTitleEnabled(enabled),
              )
            }
          />
        </div>
        <div className="title-preview">
          {view.title.previewTitle || 'Предпросмотр появится после добавления аккаунта'}
        </div>
        <TitleFields value={settings} onChange={setSettings} disabled={busy !== null} />
        <div className="button-row">
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('title-save', () => window.crTools.updateStreamTitle(settings))
            }
          >
            Сохранить
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
              run('title-undo', () => window.crTools.undoStreamTitle({ confirmed: true }))
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
      </section>
      <section className="streamer-panel">
        <span className="eyebrow">CLASH ACCOUNTS</span>
        <h2>Аккаунты</h2>
        <div className="account-add">
          <input
            aria-label="Тег аккаунта"
            value={tag}
            maxLength={20}
            placeholder="#TAG"
            onChange={(event) => setTag(event.target.value)}
          />
          <input
            aria-label="Название аккаунта"
            value={alias}
            maxLength={100}
            placeholder="Main"
            onChange={(event) => setAlias(event.target.value)}
          />
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
            Добавить
          </button>
        </div>
        <div className="account-list">
          {view.title.accounts.map((account) => (
            <div key={account.tag}>
              <span>
                <strong>{account.alias || account.name || account.tag}</strong>
                <small>
                  {account.tag} ·{' '}
                  {account.currentRank === null ? 'rank ?' : `#${account.currentRank}`} ·{' '}
                  {account.currentElo ?? '?'} ELO
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
      </section>
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
    <div className="streamer-form">
      <label className="form-wide">
        Шаблон
        <input
          disabled={disabled}
          maxLength={200}
          value={value.prefixTemplate}
          onChange={(event) => onChange({ ...value, prefixTemplate: event.target.value })}
        />
      </label>
      <label>
        W/L
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
          <option value="active">Активный</option>
          <option value="total">Общий</option>
        </select>
      </label>
      <label>
        Аккаунт
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
          <option value="last_active">Последний</option>
          <option value="manual">Вручную</option>
          <option value="best_elo">Лучший ELO</option>
          <option value="multiple">Несколько</option>
        </select>
      </label>
      <label>
        Ручной тег
        <input
          disabled={disabled || value.accountDisplayMode !== 'manual'}
          maxLength={20}
          value={value.manualAccountTag}
          onChange={(event) =>
            onChange({ ...value, manualAccountTag: event.target.value })
          }
        />
      </label>
      <NumberField
        label="Макс. аккаунтов"
        value={value.maxAccounts}
        min={1}
        max={4}
        disabled={disabled}
        onChange={(maxAccounts) => onChange({ ...value, maxAccounts })}
      />
      <label>
        Бои
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
          <option value="pathOfLegend">Path of Legends</option>
          <option value="all">Все</option>
        </select>
      </label>
      {(
        [
          ['includeRank', 'Место'],
          ['includeElo', 'ELO'],
          ['includeWl', 'W/L'],
          ['includeDelta', 'Delta'],
          ['restoreTitleOnOffline', 'Восстановить offline'],
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
    <div className="streamer-grid obs-grid">
      <section className="streamer-panel streamer-wide">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">OBS BROWSER SOURCES</span>
            <h2>Адаптивные оверлеи</h2>
          </div>
          <Toggle
            label="Включены"
            checked={settings.enabled}
            disabled={busy !== null}
            onChange={(enabled) => setSettings({ ...settings, enabled })}
          />
        </div>
        {settings.previewMode && (
          <div className="preview-warning">
            Preview mode меняет серверное поведение виджета. Выключите его перед эфиром.
          </div>
        )}
        <OverlayFields value={settings} onChange={setSettings} disabled={busy !== null} />
        <div className="button-row">
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('overlay-save', () => window.crTools.updateOverlay(settings))
            }
          >
            Сохранить OBS настройки
          </button>
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
        </div>
      </section>
      <section className="streamer-panel">
        <span className="eyebrow">CAPABILITY URLS</span>
        <h2>Ссылки OBS</h2>
        <UrlRow
          label="Streamer stats"
          available={view.overlay.urlsAvailable.stats}
          size={view.overlay.recommendedSizes.stats}
          copy={() => run('copy-stats', () => window.crTools.copyOverlayUrl('stats'))}
        />
        <UrlRow
          label="Opponent"
          available={view.overlay.urlsAvailable.opponent}
          size={view.overlay.recommendedSizes.opponent}
          copy={() =>
            run('copy-opponent', () => window.crTools.copyOverlayUrl('opponent'))
          }
        />
      </section>
      <section className="streamer-panel streamer-wide">
        <span className="eyebrow">LOCAL MOCK PREVIEW</span>
        <h2>Композиция без live token</h2>
        <div className="mock-preview-grid">
          <MockStats settings={settings} />
          <MockOpponent settings={settings} />
        </div>
      </section>
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
    <div className="streamer-form overlay-form">
      <Toggle
        label="Stats widget"
        checked={value.streamerStatsEnabled}
        disabled={disabled}
        onChange={(streamerStatsEnabled) => onChange({ ...value, streamerStatsEnabled })}
      />
      <Toggle
        label="Opponent widget"
        checked={value.opponentEnabled}
        disabled={disabled}
        onChange={(opponentEnabled) => onChange({ ...value, opponentEnabled })}
      />
      <Toggle
        label="Preview mode"
        checked={value.previewMode}
        disabled={disabled}
        onChange={(previewMode) => onChange({ ...value, previewMode })}
      />
      <Toggle
        label="Второй слайд"
        checked={value.opponentSecondSlideEnabled}
        disabled={disabled}
        onChange={(opponentSecondSlideEnabled) =>
          onChange({ ...value, opponentSecondSlideEnabled })
        }
      />
      <Toggle
        label="Matchup"
        checked={value.matchupEnabled}
        disabled={disabled}
        onChange={(matchupEnabled) => onChange({ ...value, matchupEnabled })}
      />
      <Select
        label="Preview"
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
        label="Stats layout"
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
        label="Opponent layout"
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
        label="Шрифт"
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
        label="Углы"
        value={value.widgetCornerStyle}
        options={['rounded', 'square', 'pill']}
        disabled={disabled}
        onChange={(widgetCornerStyle) =>
          onChange({
            ...value,
            widgetCornerStyle: widgetCornerStyle as OverlaySettings['widgetCornerStyle'],
          })
        }
      />
      <Select
        label="Аккаунт"
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
      <label>
        Manual tag
        <input
          disabled={disabled || value.streamerAccountMode !== 'manual'}
          maxLength={20}
          value={value.manualStreamerTag}
          onChange={(event) =>
            onChange({ ...value, manualStreamerTag: event.target.value })
          }
        />
      </label>
      {(
        [
          ['recentLimit', 'Recent', 1, 10],
          ['opponentDisplaySeconds', 'Display, sec', 5, 120],
          ['opponentSlideSeconds', 'Slide, sec', 3, 60],
          ['opponentTransitionMs', 'Opponent transition, ms', 100, 3000],
          ['statsMainSeconds', 'Stats main, sec', 5, 120],
          ['statsDeltaSeconds', 'Stats delta, sec', 2, 30],
          ['statsBetweenSeconds', 'Stats between, sec', 0, 30],
          ['statsPollMs', 'Stats poll, ms', 500, 5000],
          ['statsTransitionMs', 'Stats transition, ms', 100, 3000],
          ['matchupMinGames', 'Matchup min games', 1, 100],
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
        Matchup rank limits
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
  )
}

function MockStats({ settings }: { settings: OverlaySettings }): React.JSX.Element {
  return (
    <div
      className={`mock-widget mock-${settings.widgetCornerStyle} mock-${settings.widgetFontStyle}`}
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
    <div className="url-row">
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
        <Clipboard size={14} /> Копировать
      </button>
    </div>
  )
}
function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
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
