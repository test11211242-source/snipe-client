import { Button, Pill, Skeleton, State, type Tone } from '../../ui'
import { cx } from '../../ui/cx'
import {
  RESULT_LABEL,
  clockTime,
  meetingDay,
  meetingsCount,
  newestFirst,
  percent,
  type MeetingResult,
} from './format'
import styles from './H2H.module.css'
import type { H2HData, H2HState } from './useH2H'

import { H2H_DISCLAIMER, unavailableText } from './text'

const RESULT_TONE: Record<MeetingResult, Tone> = {
  win: 'ok',
  loss: 'danger',
  draw: 'neutral',
}

const count = (value: number | null): string => (value === null ? '—' : String(value))

/** Last meetings as dots, newest first. */
export function RecentDots({
  recent,
  limit = 5,
}: {
  recent: H2HData['recent']
  limit?: number
}): React.JSX.Element | null {
  const shown = newestFirst(recent).slice(0, limit)
  if (shown.length === 0) return null
  return (
    <span
      aria-label={`Последние встречи: ${shown.map((item) => RESULT_LABEL[item.result].toLowerCase()).join(', ')}`}
      className={styles['dots']}
      role="img"
    >
      {shown.map((item, index) => (
        <i className={styles['dot']} data-result={item.result} key={index} />
      ))}
    </span>
  )
}

function Summary({ data }: { data: H2HData }): React.JSX.Element {
  const { totals, last, recent } = data
  const meetings = totals.meetings ?? 0
  const draws = totals.draws ?? 0
  return (
    <section aria-label="Итог встреч" className={styles['summary']}>
      <div className={styles['score']}>
        <b>{count(totals.wins)}</b>
        <i>:</i>
        <b>{count(totals.losses)}</b>
      </div>
      <div className={styles['summaryMeta']}>
        <Pill tone="ok">{percent(totals.winRate)} побед</Pill>
        <span>
          {meetingsCount(meetings)} · победы : поражения
          {draws > 0 ? ` · ничьих: ${draws}` : ''}
        </span>
      </div>
      <RecentDots recent={recent} />
      {last === null ? null : (
        <div className={styles['last']}>
          <span>Последняя встреча</span>
          <b>{meetingDay(last.at)}</b>
          <Pill tone={RESULT_TONE[last.result]}>{RESULT_LABEL[last.result]}</Pill>
        </div>
      )}
    </section>
  )
}

function Accounts({ data }: { data: H2HData }): React.JSX.Element | null {
  if (data.perAccount.length === 0) return null
  return (
    <section className={styles['block']}>
      <h4>По аккаунтам</h4>
      <table className={styles['table']}>
        <thead>
          <tr>
            <th scope="col">Аккаунт</th>
            <th scope="col">Встреч</th>
            <th scope="col">В : П</th>
            <th scope="col">Побед</th>
            <th scope="col">Последняя</th>
          </tr>
        </thead>
        <tbody>
          {data.perAccount.map((account) => (
            <tr key={account.accountTag}>
              <th scope="row">
                <b>{account.alias}</b>
                <span>{account.accountTag}</span>
              </th>
              <td>{count(account.meetings)}</td>
              <td>
                <b>
                  {count(account.wins)} : {count(account.losses)}
                </b>
              </td>
              <td>{percent(account.winRate)}</td>
              <td>{account.lastAt === null ? '—' : meetingDay(account.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Recent({ data }: { data: H2HData }): React.JSX.Element | null {
  if (data.recent.length === 0) return null
  const aliases = new Map(data.perAccount.map((item) => [item.accountTag, item.alias]))
  return (
    <section className={styles['block']}>
      <h4>Последние встречи</h4>
      <ul className={styles['recent']}>
        {newestFirst(data.recent).map((meeting, index) => (
          <li key={index}>
            <span>
              {meetingDay(meeting.at)}, {clockTime(meeting.at)}
            </span>
            <b>{aliases.get(meeting.accountTag) ?? meeting.accountTag}</b>
            <Pill tone={RESULT_TONE[meeting.result]}>{RESULT_LABEL[meeting.result]}</Pill>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Full «Личные встречи» card: totals, last meeting, per-account rows and recent meetings.
 * Used by the palette and by the dialog opened from the opponent block.
 */
export function H2HCard({
  state,
  onLinkAccount,
  onRetry,
}: {
  state: H2HState
  /** «Привязать аккаунт» → settings/accounts. */
  onLinkAccount: () => void
  onRetry?: () => void
}): React.JSX.Element {
  let body: React.JSX.Element
  if (state.kind === 'loading') {
    body = (
      <div
        aria-busy="true"
        aria-label="Загружаем личные встречи"
        className={styles['loading']}
      >
        <Skeleton height={96} />
        <Skeleton height={64} />
      </div>
    )
  } else if (state.kind === 'data' && state.data.status === 'ok') {
    body = (
      <div className={styles['full']}>
        <Summary data={state.data} />
        <div className={styles['columns']}>
          <Accounts data={state.data} />
          <Recent data={state.data} />
        </div>
        {state.data.stale || !state.data.coverage.complete ? (
          <p className={styles['note']}>
            Данные могут быть неполными или не самыми свежими.
          </p>
        ) : null}
      </div>
    )
  } else if (state.kind === 'data' && state.data.status === 'none') {
    body = (
      <State headingLevel={3} icon="users" title="Нет записанных встреч">
        Ваших боёв с этим игроком в записях пока нет. Новая встреча появится здесь сама.
        {state.data.stale || !state.data.coverage.complete ? (
          <span className={styles['note']}>
            Данные могут быть неполными или не самыми свежими.
          </span>
        ) : null}
      </State>
    )
  } else if (state.kind === 'data' && state.data.status === 'no_accounts') {
    body = (
      <State
        actions={
          <Button onClick={onLinkAccount} variant="primary">
            Привязать аккаунт
          </Button>
        }
        headingLevel={3}
        icon="user"
        title="Привяжите аккаунт"
      >
        Чтобы считать личные встречи, нужен ваш аккаунт Clash Royale.
      </State>
    )
  } else {
    const { title, text } = unavailableText(state)
    body = (
      <State
        actions={
          onRetry === undefined || state.kind === 'idle' ? undefined : (
            <Button onClick={onRetry}>Повторить</Button>
          )
        }
        headingLevel={3}
        icon="info"
        title={title}
      >
        {text}
      </State>
    )
  }
  return (
    <div className={cx(styles['card'])}>
      {body}
      <p className={styles['disclaimer']}>{H2H_DISCLAIMER}</p>
    </div>
  )
}
