import type {
  MonitorResult,
  MonitorSession,
  MonitorSessionStats,
  MonitorView,
} from '../../../../shared/models/monitor'
import { Button, Icon, Pill, State } from '../../ui'
import { cx } from '../../ui/cx'
import { clockTime } from '../h2h/format'
import { describeResult } from '../monitor/history'
import type { MonitorHistory } from '../monitor/useMonitorHistory'
import { REPROCESSED_LABEL } from './labels'
import { formatDuration } from './format'
import styles from './Session.module.css'

const TONE_CLASS = {
  ok: 'toneOk',
  neutral: 'toneNeutral',
  warn: 'toneWarn',
  danger: 'toneDanger',
} as const

/** «За сессию»: live counters of the current session (view.stats). */
export function SessionStats({
  stats,
}: {
  stats: MonitorSessionStats
}): React.JSX.Element {
  const cells: { label: string; value: number; tone: 'ok' | 'warn' | 'danger' | null }[] =
    [
      { label: 'Найдено', value: stats.playersFound, tone: null },
      { label: 'Нет в базе', value: stats.playersNotFound, tone: null },
      { label: 'Не прочитано', value: stats.recognitionFailures, tone: 'warn' },
      { label: 'Ошибки сервиса', value: stats.serviceErrors, tone: 'danger' },
    ]
  return (
    <section aria-label="За сессию" className={styles['stats']}>
      <header className={styles['statsHead']}>
        <h3>За сессию</h3>
        <span>Сработок {stats.triggers}</span>
      </header>
      <dl className={styles['statGrid']}>
        {cells.map((cell) => (
          <div className={styles['stat']} key={cell.label}>
            <dt>{cell.label}</dt>
            <dd
              className={cx(
                cell.tone === 'warn' && cell.value > 0 && styles['valueWarn'],
                cell.tone === 'danger' && cell.value > 0 && styles['valueDanger'],
              )}
            >
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function HistoryRow({
  result,
  selected,
  onSelect,
}: {
  result: MonitorResult
  selected: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const model = describeResult(result)
  return (
    <button
      aria-current={selected ? 'true' : undefined}
      className={cx(styles['row'], selected && styles['rowSelected'])}
      onClick={() => onSelect(result.id)}
      type="button"
    >
      <span className={cx(styles['leadIcon'], styles[TONE_CLASS[model.tone]])}>
        <Icon name={model.icon} size={15} />
      </span>
      <span className={styles['main']}>
        <b>{model.title}</b>
        <span className={styles['sub']}>
          {model.rating === null ? null : (
            <>
              <Icon name="medal" size={12} />
              <span>{model.rating.toLocaleString('ru-RU')}</span>
              <span aria-hidden="true">•</span>
            </>
          )}
          <span className={styles['detail']}>{model.detail}</span>
        </span>
        {model.reprocessed ? (
          <span className={styles['reprocessed']}>{REPROCESSED_LABEL}</span>
        ) : null}
      </span>
      <span className={styles['trail']}>
        <time dateTime={result.timestamp}>{clockTime(result.timestamp)}</time>
        {model.repeated ? (
          <span className={styles['repeat']}>
            <Icon name="repeat" size={11} />
            уже играли
          </span>
        ) : null}
      </span>
    </button>
  )
}

/**
 * Clickable history. Selection lives in the screen; a push never moves it. Older entries
 * come from `getMonitorHistory` through «Показать ещё».
 */
export function HistoryList({
  history,
  selectedId,
  onSelect,
  historyError,
}: {
  history: MonitorHistory
  selectedId: string | null
  onSelect: (id: string) => void
  historyError: MonitorView['historyError']
}): React.JSX.Element {
  return (
    <section aria-label="История" className={styles['history']}>
      <header className={styles['statsHead']}>
        <h3>История</h3>
        <span>нажмите, чтобы открыть</span>
      </header>
      {historyError === null ? null : (
        <p className={styles['note']}>
          История пока хранится только в памяти: {historyError.message}
        </p>
      )}
      {history.items.length === 0 ? (
        history.loading ? (
          <p className={styles['empty']}>Загружаем историю…</p>
        ) : (
          <State headingLevel={3} icon="history" title="История пуста">
            Соперники появятся здесь после первого боя.
          </State>
        )
      ) : (
        <ul className={styles['list']}>
          {history.items.map((result) => (
            <li key={result.id}>
              <HistoryRow
                onSelect={onSelect}
                result={result}
                selected={result.id === selectedId}
              />
            </li>
          ))}
        </ul>
      )}
      {history.error ? (
        <p className={styles['note']}>
          Не удалось загрузить историю.{' '}
          <Button onClick={history.retry} size="sm" variant="ghost">
            Повторить
          </Button>
        </p>
      ) : history.exhausted || history.items.length === 0 ? null : (
        <Button
          className={styles['more']}
          loading={history.loading}
          onClick={history.loadMore}
          variant="ghost"
        >
          Показать ещё
        </Button>
      )}
    </section>
  )
}

/** «Итоги сессии» after Stop: replaces the invitation until dismissed. */
export function SummaryCard({
  summary,
  starting,
  onRestart,
  onClose,
}: {
  summary: MonitorSession
  starting: boolean
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  const { stats } = summary
  const range =
    summary.endedAt === null
      ? clockTime(summary.startedAt)
      : `${clockTime(summary.startedAt)}–${clockTime(summary.endedAt)}`
  const cells = [
    { label: 'найдено', value: stats.playersFound, tone: undefined },
    { label: 'нет в базе', value: stats.playersNotFound, tone: undefined },
    { label: 'не прочитано', value: stats.recognitionFailures, tone: 'warn' },
    { label: 'ошибки сервиса', value: stats.serviceErrors, tone: 'danger' },
    {
      label: 'повторные соперники',
      value: summary.distinctRepeatedOpponents,
      tone: undefined,
    },
  ] as const
  return (
    <section aria-labelledby="summary-title" className={styles['summary']}>
      <div className={styles['summaryHead']}>
        <span className={styles['summaryIcon']}>
          <Icon name="chart" size={22} />
        </span>
        <div>
          <h2 id="summary-title">Итоги сессии</h2>
          <p>
            Мониторинг остановлен · {formatDuration(summary.durationMs)} · {range}
          </p>
        </div>
      </div>
      <dl className={styles['summaryGrid']}>
        {cells.map((cell) => (
          <div key={cell.label}>
            <dt>{cell.label}</dt>
            <dd
              className={cx(
                cell.tone === 'warn' && cell.value > 0 && styles['valueWarn'],
                cell.tone === 'danger' && cell.value > 0 && styles['valueDanger'],
              )}
            >
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>
      {summary.repeatEncounters > 0 ? (
        <p className={styles['summaryRepeat']}>
          <Icon name="repeat" size={14} />
          Повторных встреч за сессию: {summary.repeatEncounters}
        </p>
      ) : null}
      <div className={styles['summaryActions']}>
        <Button loading={starting} onClick={onRestart} size="lg" variant="primary">
          <Icon name="play" size={14} />
          Начать снова
        </Button>
        <Button onClick={onClose}>Закрыть</Button>
      </div>
    </section>
  )
}

/** Reprocessed mark for the card header. */
export function ReprocessedPill(): React.JSX.Element {
  return <Pill tone="neutral">{REPROCESSED_LABEL}</Pill>
}
