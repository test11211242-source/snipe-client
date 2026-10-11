import { Button, Pill, Progress, Skeleton, State, type Tone } from '../../ui'
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
  const { totals, last } = data
  return (
    <section aria-label="Итог встреч" className={styles['summary']}>
      <div className={styles['score']}>
        <b>{count(totals.wins)}</b>
        <i>:</i>
        <b>{count(totals.losses)}</b>
        <i>:</i>
        <b>{count(totals.draws)}</b>
      </div>
      <div className={styles['summaryMeta']}>
        <Pill tone="ok">{percent(totals.winRate)} побед</Pill>
        <span>
          {totals.meetings === null
            ? 'Число встреч неизвестно'
            : meetingsCount(totals.meetings)}
          {' · победы : поражения : ничьи'}
        </span>
        <span>Процент побед — без ничьих</span>
      </div>
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

interface AccountRow {
  tag: string
  name: string | null
  wins: number | null
  losses: number | null
  draws: number | null
  winRate: number | null
  lastAt: string | null
}

function AccountName({
  name,
  tag,
}: {
  name: string | null
  tag: string
}): React.JSX.Element {
  return (
    <span className={styles['accountName']} title={name ? `${name} · ${tag}` : tag}>
      <b>{name === '' ? tag : (name ?? tag)}</b>
      {name ? <small>{tag}</small> : null}
    </span>
  )
}

function Accounts({
  title,
  accounts,
}: {
  title: string
  accounts: AccountRow[]
}): React.JSX.Element | null {
  if (accounts.length === 0) return null
  return (
    <section aria-label={title} className={styles['block']}>
      <h4>{title}</h4>
      <ul className={styles['accounts']}>
        {accounts.map((account) => (
          <li key={account.tag}>
            <AccountName name={account.name} tag={account.tag} />
            <b className={styles['accountScore']} title="Победы : поражения : ничьи">
              {count(account.wins)} : {count(account.losses)}
              {(account.draws ?? 0) > 0 ? ` : ${count(account.draws)}` : ''}
            </b>
            <div className={styles['accountRate']}>
              {account.winRate === null ? null : (
                <Progress
                  value={account.winRate}
                  label={`Победы ${account.name === '' ? account.tag : (account.name ?? account.tag)}, без ничьих`}
                />
              )}
              <span>{percent(account.winRate)}</span>
            </div>
            <time
              className={styles['accountDate']}
              dateTime={account.lastAt ?? undefined}
              title="Последняя встреча"
            >
              {account.lastAt === null ? '—' : meetingDay(account.lastAt)}
            </time>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Pairs({ data }: { data: H2HData }): React.JSX.Element | null {
  if (!data.pairs?.length) return null
  const owners = new Set(data.perAccount.map((account) => account.accountTag))
  const opponents = new Set(data.perOpponentAccount?.map((account) => account.tag))
  for (const pair of data.pairs) {
    owners.add(pair.ownerTag)
    opponents.add(pair.opponentTag)
  }
  if (owners.size <= 1 && opponents.size <= 1) return null
  return (
    <section aria-label="Пары" className={styles['block']}>
      <h4>
        Пары <span className={styles['sectionHint']}>победы : поражения</span>
      </h4>
      <ul className={styles['pairs']}>
        {data.pairs.map((pair) => (
          <li key={`${pair.ownerTag}:${pair.opponentTag}`}>
            <AccountName name={pair.ownerName} tag={pair.ownerTag} />
            <span className={styles['pairSeparator']} aria-label="против">
              ×
            </span>
            <AccountName name={pair.opponentName} tag={pair.opponentTag} />
            <b className={styles['accountScore']}>
              {count(pair.wins)} : {count(pair.losses)}
            </b>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Recent({ data }: { data: H2HData }): React.JSX.Element | null {
  if (data.recent.length === 0) return null
  const aliases = new Map(data.perAccount.map((item) => [item.accountTag, item.alias]))
  const opponents = new Map(data.perOpponentAccount?.map((item) => [item.tag, item.name]))
  return (
    <section aria-label="Последние бои" className={styles['block']}>
      <h4>Последние бои</h4>
      <ul className={styles['recent']}>
        {newestFirst(data.recent).map((meeting, index) => {
          const ownerTag = meeting.ownerTag ?? meeting.accountTag
          const opponentTag = meeting.opponentTag
          return (
            <li key={index}>
              <time dateTime={meeting.at}>
                {meetingDay(meeting.at)}, {clockTime(meeting.at)}
              </time>
              <div className={styles['recentAccounts']}>
                <AccountName name={aliases.get(ownerTag) ?? null} tag={ownerTag} />
                {opponentTag === undefined ? null : (
                  <>
                    <span className={styles['pairSeparator']} aria-label="против">
                      ×
                    </span>
                    <AccountName
                      name={opponents.get(opponentTag) ?? null}
                      tag={opponentTag}
                    />
                  </>
                )}
              </div>
              <Pill tone={RESULT_TONE[meeting.result]}>
                {RESULT_LABEL[meeting.result]}
              </Pill>
            </li>
          )
        })}
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
          <Accounts
            title="Мои аккаунты"
            accounts={state.data.perAccount.map((account) => ({
              ...account,
              tag: account.accountTag,
              name: account.alias,
            }))}
          />
          <Accounts
            title="Аккаунты соперника"
            accounts={state.data.perOpponentAccount ?? []}
          />
        </div>
        <Pairs data={state.data} />
        <Recent data={state.data} />
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
