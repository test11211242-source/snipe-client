import type { SetupSessionView } from '../../../../shared/models/setup'
import { Banner, Button, Icon, Progress, cx, type IconName } from '../../ui'
import { FrameStage, type StageBox } from './FrameStage'
import { saveRetryable } from './errors'
import { projectInnerRect } from './geometry'
import { describeOutcome } from './outcome'
import { regionsOf, triggerRegionOf } from './regions'
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
 * The analyzed trigger and the regions about to be saved. The trigger was analyzed by the
 * real analyzer in main; the quality shown is its own grade and score.
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
  const profile = view.triggerProfile
  const trigger = view.regions[triggerRegionOf(view.kind)]
  const inner =
    trigger === null || profile === null
      ? null
      : projectInnerRect(trigger, profile.innerRect)
  const medium = profile?.quality.grade === 'medium'
  const score = Math.round((profile?.quality.score ?? 0) * 100)
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
      <div className={styles['split']}>
        <div className={styles['bezel']}>
          <div className={styles['bezelBar']}>
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <span className={styles['bezelTitle']}>
              {view.source.label} — кадр с отмеченными областями
            </span>
          </div>
          {frameUrl !== null && frameSize !== null ? (
            <FrameStage
              badge="Триггер проверен"
              boxes={boxes}
              draft={null}
              editable={false}
              frameSize={frameSize}
              frameUrl={frameUrl}
              inner={inner}
              onDraft={() => undefined}
            />
          ) : null}
        </div>
        <section aria-label="Проверка" className={styles['panel']}>
          <Badge icon={medium ? 'alert' : 'check'} tone={medium ? 'warn' : 'ok'} />
          <h1 className={styles['h2']}>
            {medium ? 'Триггер найден, но качество среднее' : 'Триггер проверен'}
          </h1>
          <p className={styles['p']}>
            {medium
              ? 'Мониторинг может изредка пропускать начало боя. Сохранить можно, но лучше поправить области.'
              : result
                ? 'Проверьте области и сохраните: прогнозы смогут закрываться по итогу боя.'
                : 'Проверьте области и сохраните профиль.'}
          </p>
          <div className={styles['sum']}>
            <SummaryRow icon="check" title="Источник" value={view.source.label} />
            <SummaryRow
              icon="check"
              title="Размер кадра"
              value={frameSize === null ? '' : `${frameSize.width} × ${frameSize.height}`}
            />
            <SummaryRow
              icon={medium ? 'alert' : 'check'}
              title="Триггер"
              tone={medium ? 'warn' : 'ok'}
              value={medium ? 'качество среднее' : 'качество высокое'}
            />
            <SummaryRow
              icon="check"
              title="Области"
              value={`${defs.length} из ${defs.length} отмечены вручную`}
            />
          </div>
          <div className={styles['conf']}>
            <div className={styles['confTop']}>
              <span>Качество триггера</span>
              <b>{score}%</b>
            </div>
            <Progress
              label="Качество триггера"
              tone={medium ? 'warn' : 'ok'}
              value={score}
            />
          </div>
          {medium ? (
            <ul className={styles['tips']}>
              <li className={styles['tip']}>
                <span className={styles['tipIcon']}>
                  <Icon name="info" size={14} />
                </span>
                Повторите настройку, когда на экране нет лишних окон и подсказок.
              </li>
              <li className={styles['tip']}>
                <span className={styles['tipIcon']}>
                  <Icon name="info" size={14} />
                </span>
                Или поправьте рамку триггера — проверка выполнится заново.
              </li>
            </ul>
          ) : null}
          {session.error === null ? null : (
            <div className={styles['alert']}>
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
                  : medium
                    ? 'Всё равно сохранить профиль'
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

/** The session ended without a saved result: failed capture or cancelled by main. */
export function FailureView({
  view,
  message,
  onRetry,
  retryLabel,
  onClose,
  busy,
}: {
  view: SetupSessionView | null
  message: string
  onRetry: (() => void) | null
  retryLabel: string
  onClose: () => void
  busy: boolean
}): React.JSX.Element {
  const notSaved = view?.saveOutcome?.local === 'failed'
  return (
    <div className={styles['full']}>
      <section
        aria-label="Настройка не завершена"
        className={cx(styles['panel'], styles['narrow'])}
      >
        <Badge icon="alert" tone="warn" />
        <h1 className={styles['h2']}>Настройка не завершена</h1>
        <p className={styles['p']}>{message}</p>
        {notSaved ? (
          <Banner icon="alert" title="Не сохранено" tone="warn">
            Настройка не сохранена на этом компьютере; серверная проекция не изменена.
          </Banner>
        ) : null}
        <div className={cx(styles['actions'], styles['actionsStart'])}>
          {onRetry === null ? null : (
            <Button disabled={busy} onClick={onRetry} variant="primary">
              <Icon name="refresh" size={15} />
              {retryLabel}
            </Button>
          )}
          <Button disabled={busy} onClick={onClose}>
            Закрыть
          </Button>
        </div>
      </section>
    </div>
  )
}
