import { Button, Icon, Pill, Skeleton } from '../../ui'
import { cx } from '../../ui/cx'
import { RecentDots } from './H2HCard'
import { H2H_DISCLAIMER, unavailableText } from './text'
import { RESULT_LABEL, meetingDay, percent } from './format'
import styles from './H2H.module.css'
import type { H2HState } from './useH2H'

const count = (value: number | null): string => (value === null ? '—' : String(value))

function Heading(): React.JSX.Element {
  return (
    <div className={styles['blockHead']}>
      <Icon name="repeat" size={13} />
      <span>Личные встречи</span>
    </div>
  )
}

/**
 * «Личные встречи» next to the opponent's decks (`panel`, wide) or as one line under the
 * name (`line`, medium and mini). Every variant opens the full card via `onOpen`.
 */
export function H2HBlock({
  state,
  variant,
  onOpen,
  onLinkAccount,
}: {
  state: H2HState
  variant: 'panel' | 'line'
  onOpen: () => void
  onLinkAccount: () => void
}): React.JSX.Element {
  const line = variant === 'line'
  const frame = cx(styles['miniBlock'], line && styles['line'])

  if (state.kind === 'loading')
    return (
      <div aria-busy="true" aria-label="Загружаем личные встречи" className={frame}>
        {line ? null : <Heading />}
        <Skeleton height={line ? 20 : 120} />
      </div>
    )

  if (state.kind === 'data' && state.data.status === 'ok') {
    const { totals, last, recent, perAccount } = state.data
    if (line)
      return (
        <button
          aria-label="Личные встречи: открыть подробности"
          className={cx(frame, styles['lineButton'])}
          onClick={onOpen}
          title={H2H_DISCLAIMER}
          type="button"
        >
          <span className={styles['lineMain']}>
            <span>Встречи</span>
            <b>
              {count(totals.wins)}–{count(totals.losses)}
            </b>
            <span>· {percent(totals.winRate)}</span>
            <RecentDots recent={recent} />
            <Icon name="chevronRight" size={14} />
          </span>
          <span className={styles['lineNote']}>{H2H_DISCLAIMER}</span>
        </button>
      )
    return (
      <div className={frame}>
        <Heading />
        <div className={styles['score']}>
          <b>{count(totals.wins)}</b>
          <i>:</i>
          <b>{count(totals.losses)}</b>
        </div>
        <span className={styles['caption']}>
          победы · поражения
          {(totals.draws ?? 0) > 0 ? ` · ничьих: ${totals.draws}` : ''}
        </span>
        <div className={styles['chips']}>
          <Pill tone="ok">{percent(totals.winRate)} побед</Pill>
        </div>
        <RecentDots recent={recent} />
        <ul className={styles['accountLines']}>
          {perAccount.slice(0, 2).map((account) => (
            <li key={account.accountTag}>
              <span>{account.alias}</span>
              <b>
                {count(account.wins)}:{count(account.losses)}
              </b>
            </li>
          ))}
        </ul>
        {last === null ? null : (
          <span className={styles['caption']}>
            Последняя: {meetingDay(last.at)}, {RESULT_LABEL[last.result].toLowerCase()}
          </span>
        )}
        <Button onClick={onOpen} size="sm" variant="ghost">
          Все встречи
          <Icon name="chevronRight" size={14} />
        </Button>
        <span className={styles['caption']}>{H2H_DISCLAIMER}</span>
      </div>
    )
  }

  if (state.kind === 'data' && state.data.status === 'none')
    return (
      <div className={frame}>
        <Heading />
        <b className={styles['blockTitle']}>Нет записанных встреч</b>
        <span className={styles['caption']}>
          Ваших боёв с этим игроком в записях пока нет.
        </span>
        <span className={styles['caption']}>{H2H_DISCLAIMER}</span>
      </div>
    )

  if (state.kind === 'data' && state.data.status === 'no_accounts')
    return (
      <div className={frame}>
        <Heading />
        <b className={styles['blockTitle']}>Привяжите аккаунт</b>
        <span className={styles['caption']}>
          Без вашего аккаунта встречи не посчитать.
        </span>
        <Button onClick={onLinkAccount} size="sm">
          Привязать аккаунт
        </Button>
        <span className={styles['caption']}>{H2H_DISCLAIMER}</span>
      </div>
    )

  const { title, text } = unavailableText(
    state.kind === 'data' ? { kind: 'unavailable', reason: 'failed' } : state,
  )
  return (
    <div className={frame}>
      <Heading />
      <b className={styles['blockTitle']}>{title}</b>
      <span className={styles['caption']}>{text}</span>
      <span className={styles['caption']}>{H2H_DISCLAIMER}</span>
    </div>
  )
}
