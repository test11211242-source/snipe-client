import type { SetupSessionView } from '../../../../shared/models/setup'
import { Banner, Button, Icon, Spinner, cx } from '../../ui'
import { autoFailureText, isSourceLostCode } from './errors'
import { Badge } from './ResultViews'
import styles from './Setup.module.css'
import { useDetectionPreview, useRemainingMs } from './useDetectionPreview'
import type { SetupSession } from './useSetupSession'

const RING_RADIUS = 38
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** `0:47`: whole seconds left, rounded up so the ring reaches 0:00 only at the deadline. */
function clock(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function Countdown({
  startedAt,
  deadlineAt,
}: {
  startedAt: string
  deadlineAt: string
}): React.JSX.Element {
  const remaining = useRemainingMs(deadlineAt)
  const total = Math.max(1, Date.parse(deadlineAt) - Date.parse(startedAt))
  const spent = Math.min(1, Math.max(0, 1 - remaining / total))
  return (
    <span className={styles['ring']} role="timer">
      <svg aria-hidden="true" height="84" viewBox="0 0 84 84" width="84">
        <circle
          cx="42"
          cy="42"
          fill="none"
          r={RING_RADIUS}
          stroke="var(--color-surface-3)"
          strokeWidth="5"
        />
        <circle
          cx="42"
          cy="42"
          fill="none"
          r={RING_RADIUS}
          stroke="var(--color-accent)"
          strokeDasharray={RING_LENGTH.toFixed(1)}
          strokeDashoffset={(RING_LENGTH * spent).toFixed(1)}
          strokeLinecap="round"
          strokeWidth="5"
          transform="rotate(-90 42 42)"
        />
      </svg>
      <b className={styles['ringNum']}>{clock(remaining)}</b>
    </span>
  )
}

/**
 * Waiting for the training battle: one sentence, the live picture of the window and the
 * real 60-second limit. No stages, scores or analyzer words (owner rule §1.3).
 */
function AutoWait({
  view,
  detection,
  busy,
  onManual,
}: {
  view: SetupSessionView
  detection: NonNullable<SetupSessionView['detection']>
  busy: boolean
  onManual: () => void
}): React.JSX.Element {
  const picture = useDetectionPreview(view.sessionId, true)
  return (
    <>
      <div className={styles['split']}>
        <section aria-label="Живая картинка окна" className={styles['bezel']}>
          <div className={styles['bezelBar']}>
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <span className={styles['bezelTitle']}>{view.source.label}</span>
          </div>
          <div className={styles['stage']}>
            {picture === null ? (
              <span className={styles['stageNote']}>
                <Spinner label="Ждём картинку окна" />
              </span>
            ) : (
              <img
                alt="Картинка окна игры"
                className={styles['livePicture']}
                draggable={false}
                src={picture}
              />
            )}
          </div>
        </section>
        <div className={cx(styles['panel'], styles['waitPanel'])}>
          <h1 className={styles['ask']}>
            Зайдите в тренировочный бой с Тренером Чеддером
          </h1>
          <Countdown deadlineAt={detection.deadlineAt} startedAt={detection.startedAt} />
        </div>
      </div>
      <div className={styles['foot']}>
        <span />
        <div className={styles['footRight']}>
          <Button disabled={busy} onClick={onManual}>
            Настроить вручную
          </Button>
        </div>
      </div>
    </>
  )
}

/**
 * One phrase and the ways out. A dead source cannot be retried: it has to be chosen again.
 * `null` actions are not offered.
 */
export function AutoFailure({
  message,
  error,
  busy,
  onRetry,
  onManual,
  onChooseWindow,
}: {
  message: string
  error: string | null
  busy: boolean
  onRetry: (() => void) | null
  onManual: (() => void) | null
  onChooseWindow: (() => void) | null
}): React.JSX.Element {
  return (
    <div className={styles['full']}>
      <section aria-label={message} className={cx(styles['panel'], styles['narrow'])}>
        <Badge icon="alert" tone="warn" />
        <h1 className={styles['h2']}>{message}</h1>
        {error === null ? null : (
          <div className={styles['alert']}>
            <Banner icon="alert" live title="Не получилось" tone="danger">
              {error}
            </Banner>
          </div>
        )}
        <div className={cx(styles['actions'], styles['actionsStart'])}>
          {onRetry === null ? null : (
            <Button disabled={busy} loading={busy} onClick={onRetry} variant="primary">
              <Icon name="refresh" size={15} />
              Попробовать ещё раз
            </Button>
          )}
          {onManual === null ? null : (
            <Button disabled={busy} onClick={onManual}>
              Настроить вручную
            </Button>
          )}
          {onChooseWindow === null ? null : (
            <Button disabled={busy} onClick={onChooseWindow}>
              Выбрать окно
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}

/**
 * The automatic wait of a `DETECTING` session: the countdown with the live picture while
 * it runs, and the single failure phrase once main gave up. `sourceLost` is also set when
 * a retry found the window gone, whatever the old failure code was.
 */
export function AutoStage({
  session,
  view,
  sourceLost,
  captureUnavailable,
  exiting,
  onManual,
  onChooseWindow,
}: {
  session: SetupSession
  view: SetupSessionView
  sourceLost: boolean
  captureUnavailable: boolean
  exiting: boolean
  onManual: () => void
  onChooseWindow: () => void
}): React.JSX.Element {
  const { detection } = view
  const busy = session.busy || exiting
  if (detection === null) {
    return (
      <div className={styles['full']}>
        <Spinner label="Открываем настройку" />
      </div>
    )
  }
  if (detection.status === 'running') {
    return <AutoWait busy={busy} detection={detection} onManual={onManual} view={view} />
  }
  const code = detection.failure?.code ?? null
  const lost = sourceLost || isSourceLostCode(code)
  const unavailable =
    captureUnavailable || session.errorCode === 'SETUP_CAPTURE_UNAVAILABLE'
  return (
    <AutoFailure
      busy={busy}
      error={
        (lost && isSourceLostCode(session.errorCode)) || unavailable
          ? null
          : session.error
      }
      message={autoFailureText(lost ? 'AUTO_SOURCE_LOST' : unavailable ? null : code)}
      onChooseWindow={lost || unavailable ? onChooseWindow : null}
      onManual={unavailable ? null : onManual}
      onRetry={lost || unavailable ? null : () => void session.retryDetection()}
    />
  )
}
