import type {
  DeckMode,
  MonitorResult,
  PickedEvent,
} from '../../../../shared/models/monitor'
import { Banner, Button, Card, Icon, Pill, Spinner } from '../../ui'
import type { MonitorController } from '../monitor'
import { clockTime } from '../h2h/format'
import { REPROCESSED_LABEL } from './labels'
import { ModePicker } from './ModePicker'
import styles from './Opponent.module.css'
import { SummaryCard } from './SessionPanel'
import {
  AuthRequired,
  Failed,
  FirstRun,
  Idle,
  RebindRequired,
  Searching,
  Starting,
  Stopped,
  Stopping,
  WaitingSource,
} from './StateBodies'
import { ResultBody } from './ResultBody'
import type { OpponentPresentation } from './types'

const MODE_NAME: Record<DeckMode, string> = {
  pol: 'Путь легенд',
  gt: 'Турнир',
  challenge: 'Испытание',
}

function resultStatus(result: MonitorResult): {
  text: string
  tone: 'ok' | 'neutral' | 'warn' | 'danger'
} {
  const time = clockTime(result.timestamp)
  switch (result.kind) {
    case 'player_found':
      return { text: `найден в ${time}`, tone: 'ok' }
    case 'player_not_found':
      return { text: `нет в базе · ${time}`, tone: 'neutral' }
    case 'recognition_failed':
      return { text: `ник не прочитан · ${time}`, tone: 'warn' }
    case 'service_error':
      return { text: `сбой сервиса · ${time}`, tone: 'danger' }
  }
}

function Head({
  presentation,
  deckMode,
  event,
  onDeckMode,
  disabled,
}: {
  presentation: OpponentPresentation
  deckMode: DeckMode
  event: PickedEvent | null
  onDeckMode: (mode: DeckMode, event: PickedEvent | null) => void
  disabled: boolean
}): React.JSX.Element {
  const result = presentation.kind === 'result' ? presentation.result : null
  const status = result === null ? null : resultStatus(result)
  return (
    <header className={styles['head']}>
      <div className={styles['headInfo']}>
        <span className={styles['eyebrow']}>Соперник</span>
        {status !== null ? (
          <span className={styles['status']} data-tone={status.tone}>
            {status.tone === 'ok' ? <Icon name="check" size={13} /> : null}
            {status.text}
          </span>
        ) : presentation.kind === 'searching' ? (
          <span className={styles['status']} data-tone="ok">
            <Spinner />
            ищем соперника
          </span>
        ) : null}
        {result?.repeat == null ? null : (
          <Pill tone="warn">
            <Icon name="repeat" size={12} /> Уже встречались сегодня, в{' '}
            {clockTime(result.repeat.previousAt)}
          </Pill>
        )}
        {result?.reprocessed === true ? <Pill>{REPROCESSED_LABEL}</Pill> : null}
        {result !== null && result.deckMode !== deckMode ? (
          <Pill>Колоды: {MODE_NAME[result.deckMode]}</Pill>
        ) : null}
      </div>
      <ModePicker
        deckMode={deckMode}
        disabled={disabled}
        event={event}
        onPick={onDeckMode}
      />
    </header>
  )
}

export function OpponentPanel({
  presentation,
  monitor,
  deckMode,
  event,
  offlineAttempt,
  viewing,
  retry,
  onBackToCurrent,
  onCloseSummary,
}: {
  presentation: OpponentPresentation
  monitor: MonitorController
  deckMode: DeckMode
  /** The picked game event when the mode is a challenge. */
  event: PickedEvent | null
  /** Realtime connection lost: reconnect attempt number, or null when online. */
  offlineAttempt: number | null
  viewing: { title: string; hint: string } | null
  retry: { onRetry: () => void; pending: boolean } | null
  onBackToCurrent: () => void
  onCloseSummary: () => void
}): React.JSX.Element {
  let body: React.JSX.Element
  switch (presentation.kind) {
    case 'no-profile':
      return (
        <Card as="section" aria-label="Соперник" className={styles['panel']} padded>
          <FirstRun />
        </Card>
      )
    case 'starting':
      body = <Starting readiness={presentation.readiness} />
      break
    case 'stopping':
      body = <Stopping />
      break
    case 'waiting-source':
      body = <WaitingSource monitor={monitor} />
      break
    case 'rebind':
      body = <RebindRequired message={presentation.message} />
      break
    case 'failed':
      body = <Failed error={presentation.error} monitor={monitor} />
      break
    case 'stopped':
      body = <Stopped monitor={monitor} />
      break
    case 'summary':
      body = (
        <SummaryCard
          onClose={onCloseSummary}
          onRestart={() => void monitor.start()}
          starting={monitor.starting}
          summary={presentation.summary}
        />
      )
      break
    case 'auth':
      body = <AuthRequired />
      break
    case 'idle':
      body = <Idle />
      break
    case 'searching':
      body = <Searching nickname={presentation.nickname} />
      break
    case 'result':
      body = <ResultBody result={presentation.result} retry={retry} />
      break
  }
  return (
    <Card as="section" aria-label="Соперник" className={styles['panel']} padded>
      <Head
        deckMode={deckMode}
        disabled={monitor.value === null}
        event={event}
        onDeckMode={(mode, picked) => void monitor.setDeckMode(mode, picked)}
        presentation={presentation}
      />
      {offlineAttempt === null ? null : (
        <Banner icon="wifiOff" title="Нет связи с сервером" tone="warn">
          Переподключаемся… попытка {offlineAttempt}. Последний результат остаётся на
          экране.
        </Banner>
      )}
      {viewing === null ? null : (
        <Banner
          actions={
            <Button onClick={onBackToCurrent} size="sm">
              <Icon name="chevronLeft" size={14} />
              Вернуться к текущему
            </Button>
          }
          icon="history"
          title="Просмотр прошлого результата"
        >
          {viewing.title} · {viewing.hint}
        </Banner>
      )}
      <div className={styles['body']}>{body}</div>
    </Card>
  )
}
