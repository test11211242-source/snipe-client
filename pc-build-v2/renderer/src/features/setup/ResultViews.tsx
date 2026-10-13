import type { SetupSessionView } from '../../../../shared/models/setup'
import { Banner, Button, Icon, cx, type IconName } from '../../ui'
import { FrameStage, type StageBox } from './FrameStage'
import { saveRetryable } from './errors'
import { describeOutcome } from './outcome'
import { regionsOf } from './regions'
import styles from './Setup.module.css'
import type { SetupSession } from './useSetupSession'

const TONE_ICON: Record<'ok' | 'warn' | 'danger' | 'neutral' | 'info', IconName> = {
  ok: 'check',
  warn: 'alert',
  danger: 'alert',
  neutral: 'info',
  info: 'info',
}

function Badge({
  tone,
  icon,
}: {
  tone: 'ok' | 'warn' | 'danger'
  icon: IconName
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cx(
        styles['badge'],
        tone === 'warn' && styles['badgeWarn'],
        tone === 'danger' && styles['badgeDanger'],
      )}
    >
      <Icon name={icon} size={28} />
    </div>
  )
}

/**
 * The last look before saving: the frame with the drawn zones (and the game outline when
 * main found the game) and the buttons. Analyzer details stay out of the interface.
 */
export function CheckStep({
  session,
  view,
  frameUrl,
  onBack,
}: {
  session: SetupSession
  view: SetupSessionView
  frameUrl: string | null
  onBack: () => void
}): React.JSX.Element {
  const defs = regionsOf(view.kind)
  const result = view.kind === 'predictionResult'
  const inReview = view.state === 'REVIEW'
  const retryable = saveRetryable(view.error?.code)
  const { busy } = session
  const frameSize = view.frameSize

  const save = async (): Promise<void> => {
    if (view.state === 'SELECTING' && (await session.review()) === null) return
    await session.commit()
  }

  const boxes: StageBox[] = defs.map((def) => ({
    id: def.id,
    label: def.label,
    rect: view.regions[def.id],
    active: false,
    labelBelow: def.labelBelow,
  }))

  return (
    <>
      <div className={cx(styles['split'], styles['splitSingle'])}>
        <section aria-label="Проверка" className={styles['bezel']}>
          <h1 className="sr-only">Проверьте области</h1>
          <div className={styles['bezelBar']}>
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <span className={styles['bezelTitle']}>{view.source.label}</span>
          </div>
          {frameUrl !== null && frameSize !== null ? (
            <FrameStage
              boxes={boxes}
              draft={null}
              editable={false}
              frameSize={frameSize}
              frameUrl={frameUrl}
              gameViewport={view.game?.viewport ?? null}
              inset={24}
              onDraft={() => undefined}
            />
          ) : null}
          {session.error === null ? null : (
            <div className={cx(styles['alert'], styles['bezelAlert'])}>
              <Banner icon="alert" live title="Не получилось" tone="danger">
                {session.error}
              </Banner>
            </div>
          )}
        </section>
      </div>
      <div className={styles['foot']}>
        <Button disabled={busy || inReview} onClick={onBack} variant="ghost">
          Поправить области
        </Button>
        <div className={styles['footRight']}>
          {inReview && !retryable ? null : (
            <Button
              disabled={busy}
              loading={busy}
              onClick={() => void save()}
              size="lg"
              variant="primary"
            >
              {inReview
                ? 'Повторить сохранение'
                : result
                  ? 'Сохранить зоны'
                  : 'Сохранить профиль'}
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

function SummaryRow({
  icon,
  title,
  value,
  tone = 'ok',
}: {
  icon: IconName
  title: string
  value: string
  tone?: 'ok' | 'warn' | 'danger' | 'neutral'
}): React.JSX.Element {
  return (
    <div
      className={cx(
        styles['sumRow'],
        tone === 'warn' && styles['sumWarn'],
        tone === 'danger' && styles['sumDanger'],
        tone === 'neutral' && styles['sumNeutral'],
      )}
    >
      <span className={styles['sumIcon']}>
        <Icon name={icon} size={16} />
      </span>
      {title}
      <span className={styles['sumValue']}>{value}</span>
    </div>
  )
}

/**
 * After save. Local persistence, server synchronization and the monitor restart are three
 * separate facts; each is shown as main reports it, and a failed synchronization can be
 * retried without saving again.
 */
export function OutcomeView({
  session,
  view,
  onDone,
}: {
  session: SetupSession
  view: SetupSessionView
  onDone: () => void
}): React.JSX.Element {
  const outcome = describeOutcome(view)
  const { busy } = session
  return (
    <div className={styles['full']}>
      <section
        aria-label="Результат сохранения"
        className={cx(styles['panel'], styles['narrow'])}
      >
        <Badge icon={outcome.tone === 'ok' ? 'check' : 'alert'} tone={outcome.tone} />
        <h1 className={styles['h2']}>{outcome.title}</h1>
        <p className={styles['p']}>{outcome.text}</p>
        {outcome.lines.length === 0 ? null : (
          <div className={styles['sum']}>
            {outcome.lines.map((line) => (
              <SummaryRow
                icon={TONE_ICON[line.tone]}
                key={line.id}
                title={line.title}
                tone={line.tone === 'info' ? 'neutral' : line.tone}
                value={line.value}
              />
            ))}
          </div>
        )}
        {outcome.notes.map((note) => (
          <Banner icon="alert" key={note.title} title={note.title} tone="warn">
            {note.text}
          </Banner>
        ))}
        {session.error === null ? null : (
          <div className={styles['alert']}>
            <Banner icon="alert" live title="Не получилось" tone="danger">
              {session.error}
            </Banner>
          </div>
        )}
        <div className={cx(styles['actions'], styles['actionsStart'])}>
          {outcome.canRetrySync ? (
            <Button loading={busy} onClick={() => void session.retrySync()}>
              <Icon name="refresh" size={15} />
              Повторить отправку
            </Button>
          ) : null}
          <Button disabled={busy} onClick={onDone} size="lg" variant="primary">
            Готово
          </Button>
        </div>
      </section>
    </div>
  )
}

/**
 * The session ended without a saved result: failed capture or cancelled by main. With
 * `title` the heading says it all (no paragraph) and `secondary` stands in for «Закрыть».
 */
export function FailureView({
  view,
  message,
  title = 'Настройка не завершена',
  note = null,
  onRetry,
  retryLabel,
  secondary = null,
  onClose,
  busy,
}: {
  view: SetupSessionView | null
  message: string | null
  title?: string
  /** Why the last attempt to recover did not work. */
  note?: string | null
  onRetry: (() => void) | null
  retryLabel: string
  secondary?: { label: string; onClick: () => void } | null
  onClose: () => void
  busy: boolean
}): React.JSX.Element {
  const notSaved = view?.saveOutcome?.local === 'failed'
  return (
    <div className={styles['full']}>
      <section aria-label={title} className={cx(styles['panel'], styles['narrow'])}>
        <Badge icon="alert" tone="warn" />
        <h1 className={styles['h2']}>{title}</h1>
        {message === null ? null : <p className={styles['p']}>{message}</p>}
        {notSaved ? (
          <Banner icon="alert" title="Не сохранено" tone="warn">
            Настройка не сохранена на этом компьютере; серверная проекция не изменена.
          </Banner>
        ) : null}
        {note === null ? null : (
          <div className={styles['alert']}>
            <Banner icon="alert" live title="Не получилось" tone="danger">
              {note}
            </Banner>
          </div>
        )}
        <div className={cx(styles['actions'], styles['actionsStart'])}>
          {onRetry === null ? null : (
            <Button disabled={busy} loading={busy} onClick={onRetry} variant="primary">
              <Icon name="refresh" size={15} />
              {retryLabel}
            </Button>
          )}
          {secondary === null ? (
            <Button disabled={busy} onClick={onClose}>
              Закрыть
            </Button>
          ) : (
            <Button disabled={busy} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}
