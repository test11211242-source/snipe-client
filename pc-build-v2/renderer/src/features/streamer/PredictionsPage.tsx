import { useState } from 'react'

import type { PredictionPreferences } from '../../../../shared/models/streamer'
import {
  Banner,
  Button,
  Card,
  Group,
  Icon,
  Pill,
  Requirements,
  Segment,
  Setting,
  Stepper,
  Switch,
  type Tone,
} from '../../ui'
import { StreamerGate } from './StreamerGate'
import { useStreamer } from './streamerContext'
import styles from './Streamer.module.css'
import { missingFor, useFoundations, useRequirements } from './useRequirements'
import { useRunner } from './useRunner'

const RUNTIME: Record<PredictionRuntime, { tone: Tone; label: string }> = {
  stopped: { tone: 'neutral', label: 'Выключены' },
  starting: { tone: 'neutral', label: 'Запускаются…' },
  active: { tone: 'ok', label: 'Включены, идут сами' },
  failed: { tone: 'danger', label: 'Ошибка запуска' },
  unknown: { tone: 'neutral', label: 'Нет данных' },
}
type PredictionRuntime = 'stopped' | 'starting' | 'active' | 'failed' | 'unknown'

/** Prediction preferences are only editable while predictions are off. */
export function PredictionsPage(): React.JSX.Element {
  return (
    <StreamerGate>
      <Predictions />
    </StreamerGate>
  )
}

function Predictions(): React.JSX.Element {
  const { view, pendingKeys } = useStreamer()
  const { run, error, clearError } = useRunner()
  const requirements = useRequirements('predictions')
  const ready = missingFor('predictions', useFoundations()).length === 0
  // The draft survives a failed start; null means "show the saved preferences".
  const [draft, setDraft] = useState<PredictionPreferences | null>(null)
  if (view === null) return <></>

  const { predictions } = view
  const active = predictions.active
  const locked = active || predictions.runtimeState === 'starting'
  const settings = draft ?? predictions.settings
  const change = (patch: Partial<PredictionPreferences>): void =>
    setDraft({ ...settings, ...patch })
  const runtime = RUNTIME[predictions.runtimeState]
  const busy = pendingKeys.has('predictions.toggle')

  const toggle = (): void => {
    clearError()
    void run(
      active ? { action: 'predictions.stop' } : { action: 'predictions.start', settings },
      { key: 'predictions.toggle' },
    ).then((outcome) => {
      if (outcome.status === 'ok') setDraft(null)
    })
  }
  const stats = predictions.statistics

  return (
    <div className={styles['page']}>
      <Banner
        icon="wand"
        title={active ? 'Прогнозы идут сами' : 'Прогнозы работают сами'}
        tone={active ? 'ok' : 'neutral'}
      >
        Прогноз открывается, когда начинается бой, и закрывается по итогу боя. Включите
        один раз — во время эфира ничего нажимать не нужно.
      </Banner>
      <Requirements items={requirements} />
      <Group
        title="Как работают прогнозы"
        trail={locked ? <span>изменение недоступно, пока идут прогнозы</span> : undefined}
      >
        <Card padded>
          <Setting hint="Что угадывают зрители" title="Сценарий">
            <Segment
              label="Сценарий прогноза"
              onChange={(predictionType) => change({ predictionType })}
              options={[
                { value: 'win_lose', label: 'Победа / поражение', disabled: locked },
                { value: 'win_streak', label: 'Серия побед', disabled: locked },
                { value: 'mix', label: 'Смешанный', disabled: locked },
              ]}
              value={settings.predictionType}
            />
          </Setting>
          <Setting hint="От 30 секунд до 30 минут" title="Время на голосование">
            <Stepper
              disabled={locked}
              format={(value) => `${value} с`}
              label="Время на голосование, секунд"
              max={1800}
              min={30}
              onChange={(predictionWindow) => change({ predictionWindow })}
              step={30}
              value={settings.predictionWindow}
            />
          </Setting>
          {settings.predictionType === 'win_lose' ? null : (
            <Setting
              hint="Для сценариев «Серия побед» и «Смешанный»"
              title="Побед в серии"
            >
              <Stepper
                disabled={locked}
                label="Побед в серии"
                max={10}
                min={2}
                onChange={(winStreakCount) => change({ winStreakCount })}
                step={1}
                value={settings.winStreakCount}
              />
            </Setting>
          )}
          <Setting hint="Сколько ждать после итога боя" title="Пауза между прогнозами">
            <Stepper
              disabled={locked}
              format={(value) => `${value} с`}
              label="Пауза между прогнозами, секунд"
              max={60}
              min={1}
              onChange={(delayBetweenPredictions) => change({ delayBetweenPredictions })}
              step={1}
              value={settings.delayBetweenPredictions}
            />
          </Setting>
          <Setting
            hint="Сразу после итога боя, без ваших действий"
            title="Открывать следующий прогноз сам"
          >
            <Switch
              checked={settings.autoCreateNext}
              disabled={locked}
              label="Создавать следующий прогноз сам"
              onChange={(autoCreateNext) => change({ autoCreateNext })}
            />
          </Setting>
        </Card>
      </Group>
      {error === null ? null : (
        <Banner icon="alert" title="Не получилось" tone="danger">
          {error} Параметры сохранены в форме.
        </Banner>
      )}
      <Group title="Управление">
        <Card padded>
          <div className={styles['controlRow']}>
            {active ? (
              <Button loading={busy} onClick={toggle} size="lg" variant="danger">
                <Icon name="stop" size={15} />
                Выключить прогнозы
              </Button>
            ) : (
              <Button
                disabled={!ready || locked}
                loading={busy}
                onClick={toggle}
                size="lg"
                variant="primary"
              >
                <Icon name="play" size={15} />
                Включить прогнозы
              </Button>
            )}
            <Pill tone={runtime.tone}>{runtime.label}</Pill>
            {!active && !ready ? (
              <span className={styles['fnLabel']}>
                <Icon name="info" size={13} />
                Закройте пункты выше
              </span>
            ) : null}
          </div>
          {active && stats.activeTitle !== null ? (
            <div className={styles['activeTitle']}>
              <span>Текущий прогноз</span>«{stats.activeTitle}»
            </div>
          ) : null}
          <div className={styles['stats']}>
            <div className={styles['stat']}>
              <b>{stats.total}</b>
              <small>Всего прогнозов</small>
            </div>
            <div className={styles['stat']}>
              <b>{stats.successful}</b>
              <small>Успешных</small>
            </div>
            <div className={styles['stat']}>
              <b>{stats.successRate}%</b>
              <small>Доля успешных</small>
            </div>
            <div className={styles['stat']}>
              <b>{stats.currentWinStreak}</b>
              <small>Серия побед</small>
            </div>
          </div>
        </Card>
      </Group>
    </div>
  )
}
