import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import type {
  PredictionPreferences,
  StreamerView,
} from '../../../../shared/models/streamer'
import { Button, Status } from '../ui'
import {
  DraftStatus,
  Metric,
  NumberField,
  Requirement,
  Select,
  StreamerToggle,
} from './controls'
import { predictionStateLabel, useDraft } from './state'
import type { StreamerRunner } from './types'

export function PredictionsTab({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: StreamerRunner
}): React.JSX.Element {
  const {
    draft: settings,
    setDraft: setSettings,
    dirty,
  } = useDraft(view.predictions.settings)
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set())
  const requirements = view.predictions.requirements
  const ready =
    requirements.twitchConnected &&
    requirements.mainMonitorConfigured &&
    requirements.resultConfigured
  const invalid = invalidFields.size > 0

  const setValidity = (fieldKey: string, fieldInvalid: boolean): void => {
    setInvalidFields((current) => {
      const next = new Set(current)
      if (fieldInvalid) next.add(fieldKey)
      else next.delete(fieldKey)
      return next
    })
  }

  return (
    <div className="streamer-context-layout prediction-layout">
      <section className="streamer-panel streamer-context-main prediction-control">
        <div className="streamer-section-heading">
          <div>
            <span className="eyebrow">АВТОМАТИЗАЦИЯ</span>
            <h2>Прогнозы канала</h2>
          </div>
          <Status
            label={view.predictions.active ? 'Выполняются' : 'Остановлены'}
            tone={view.predictions.active ? 'success' : 'neutral'}
          />
        </div>
        <p className="streamer-lead">
          {view.predictions.active
            ? predictionStateLabel(view.predictions.state)
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
          <strong title={view.predictions.statistics.activeTitle ?? undefined}>
            {view.predictions.statistics.activeTitle ?? 'Активного прогноза сейчас нет'}
          </strong>
        </div>
        <PredictionFields
          value={settings}
          onChange={setSettings}
          disabled={busy !== null || view.predictions.active}
          onValidityChange={setValidity}
        />
        <div className="draft-row">
          <DraftStatus dirty={dirty} invalid={invalid} />
        </div>
        <div className="streamer-action-row">
          {view.predictions.active ? (
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() => void run('stop-predictions', window.crTools.stopPredictions)}
            >
              Остановить прогнозы
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy !== null || !ready || invalid}
              onClick={() =>
                void run('start-predictions', () =>
                  window.crTools.startPredictions(settings),
                )
              }
            >
              Запустить прогнозы
            </Button>
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
            <Status
              label={view.twitch.connected ? 'Подключён' : 'Не подключён'}
              tone={view.twitch.connected ? 'success' : 'warning'}
            />
          </div>
          <p>
            {view.twitch.connected
              ? `Команды отправляются в канал @${view.twitch.username ?? 'без имени'}.`
              : view.twitch.polling
                ? 'Ожидаем завершения авторизации в системном браузере.'
                : 'Подключите канал, чтобы создавать прогнозы.'}
          </p>
          {view.twitch.connected ? (
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm('Отключить Twitch и отозвать серверный токен?')) {
                  void run('disconnect', () =>
                    window.crTools.disconnectTwitch({ confirmed: true }),
                  )
                }
              }}
            >
              Отключить Twitch
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() => void run('connect', window.crTools.connectTwitch)}
            >
              <ExternalLink aria-hidden="true" size={16} />
              Подключить Twitch
            </Button>
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
  onValidityChange,
}: {
  value: PredictionPreferences
  onChange: (value: PredictionPreferences) => void
  disabled: boolean
  onValidityChange: (fieldKey: string, invalid: boolean) => void
}): React.JSX.Element {
  return (
    <div className="streamer-settings-block prediction-settings">
      <div className="streamer-form prediction-primary-form">
        <Select
          label="Сценарий прогноза"
          disabled={disabled}
          value={value.predictionType}
          options={[
            ['win_lose', 'Победа или поражение'],
            ['win_streak', 'Серия побед'],
            ['mix', 'Смешанный сценарий'],
          ]}
          onChange={(predictionType) => onChange({ ...value, predictionType })}
        />
        <NumberField
          fieldKey="predictionWindow"
          label="Окно голосования, сек"
          value={value.predictionWindow}
          min={30}
          max={1800}
          disabled={disabled}
          onChange={(predictionWindow) => onChange({ ...value, predictionWindow })}
          onValidityChange={onValidityChange}
        />
      </div>
      <div className="streamer-switch-grid single-switch">
        <StreamerToggle
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
            fieldKey="winStreakCount"
            label="Побед в целевой серии"
            value={value.winStreakCount}
            min={2}
            max={10}
            disabled={disabled}
            onChange={(winStreakCount) => onChange({ ...value, winStreakCount })}
            onValidityChange={onValidityChange}
          />
          <NumberField
            fieldKey="delayBetweenPredictions"
            label="Пауза между прогнозами, сек"
            value={value.delayBetweenPredictions}
            min={1}
            max={60}
            disabled={disabled}
            onChange={(delayBetweenPredictions) =>
              onChange({ ...value, delayBetweenPredictions })
            }
            onValidityChange={onValidityChange}
          />
        </div>
      </details>
    </div>
  )
}
