import { Settings2 } from 'lucide-react'

import type { StreamerView } from '../../../../shared/models/streamer'
import { Button, Status } from '../ui'
import { Metric, Requirement, StreamerToggle } from './controls'
import { predictionStateLabel } from './state'
import type { StreamerRunner } from './types'

export function OverviewTab({
  view,
  busy,
  run,
}: {
  view: StreamerView
  busy: string | null
  run: StreamerRunner
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
                ? `Twitch @${view.twitch.username ?? 'канал'}`
                : 'Twitch не подключён'}
            </h2>
          </div>
          <Status
            label={view.twitch.connected ? 'Канал подключён' : 'Требуется подключение'}
            tone={view.twitch.connected ? 'success' : 'warning'}
          />
        </div>
        <p className="streamer-lead">
          Сводка автоматизации, которая работает во время трансляции.
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
            value={view.overlay.settings.enabled ? 'Включён' : 'Выключен'}
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
            <strong title={view.predictions.statistics.activeTitle ?? undefined}>
              {view.predictions.statistics.activeTitle ?? 'Нет активного прогноза'}
            </strong>
            <small>{predictionStateLabel(view.predictions.state)}</small>
          </div>
          <div>
            <span>Название канала</span>
            <strong title={view.title.previewTitle || undefined}>
              {view.title.previewTitle || 'Название появится после настройки аккаунта'}
            </strong>
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
          <Button
            disabled={busy !== null}
            onClick={() => void run('setup', window.crTools.startStreamerResultSetup)}
          >
            <Settings2 aria-hidden="true" size={16} />
            Настроить зоны
          </Button>
        </section>
        <section className="streamer-panel streamer-deck-panel">
          <span className="eyebrow">ЧАТ TWITCH</span>
          <h2>Публикация колод</h2>
          <p>Отправляет распознанную колоду в чат подключённого канала.</p>
          <StreamerToggle
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
