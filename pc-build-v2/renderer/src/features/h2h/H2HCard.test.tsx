// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { H2HCard } from './H2HCard'
import { H2HBlock } from './H2HBlock'
import type { H2HData } from './useH2H'
import { clockTime } from './format'

afterEach(cleanup)
const at = '2026-10-10T12:00:00Z'
const owner = {
  accountTag: '#JCU',
  alias: 'Мой основной',
  meetings: 4,
  wins: 2,
  losses: 1,
  draws: 1,
  decisiveMeetings: 3,
  winRate: 66.7,
  lastAt: at,
  lastResult: 'win' as const,
}
const opponent = {
  tag: '#PQL',
  name: 'Соперник основной',
  total: 4,
  wins: 2,
  losses: 1,
  draws: 1,
  decisiveMeetings: 3,
  winRate: 66.7,
  lastAt: at,
}
const pair = {
  ownerTag: owner.accountTag,
  ownerName: owner.alias,
  opponentTag: opponent.tag,
  opponentName: opponent.name,
  total: 4,
  wins: 2,
  losses: 1,
  draws: 1,
  lastAt: at,
}
const meeting = {
  at,
  result: 'win' as const,
  accountTag: '#JCU',
  ownerTag: '#JCU',
  opponentTag: '#PQL',
}
const data: H2HData = {
  status: 'ok',
  opponent: { tag: '#PQL' },
  scope: 'recorded_path_of_legends',
  coverage: { source: 'cr_stats_current_and_archives', complete: true },
  updatedAt: at,
  stale: false,
  totals: {
    meetings: 4,
    wins: 2,
    losses: 1,
    draws: 1,
    decisiveMeetings: 3,
    winRate: 66.7,
  },
  last: meeting,
  recent: [meeting],
  perAccount: [owner],
  perOpponentAccount: [opponent],
  pairs: [pair],
}
function mount(value: H2HData = data) {
  return render(<H2HCard state={{ kind: 'data', data: value }} onLinkAccount={vi.fn()} />)
}

describe('Detailed H2H', () => {
  it('renders totals, both account sides, pairs and the accounts in recent battles', () => {
    mount({
      ...data,
      perAccount: [owner, { ...owner, accountTag: '#YQP', alias: 'Мой второй' }],
    })
    expect(screen.getByLabelText('Итог встреч')).toHaveTextContent('2:1:1')
    expect(screen.getByText('Процент побед — без ничьих')).toBeInTheDocument()
    expect(screen.getByText('4 встречи · победы : поражения : ничьи')).toBeInTheDocument()
    expect(screen.getByText('Последняя встреча')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Мои аккаунты' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Аккаунты соперника' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Пары' })).toHaveTextContent('2 : 1')
    const recent = within(screen.getByRole('region', { name: 'Последние бои' }))
    expect(recent.getByText('Мой основной')).toBeInTheDocument()
    expect(recent.getByText('Соперник основной')).toBeInTheDocument()
    expect(recent.getByText('Победа')).toBeInTheDocument()
    expect(recent.getByText(new RegExp(clockTime(at)))).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar')).toHaveLength(3)
  })

  it('hides all absent or empty detail sections on old servers', () => {
    const old = { ...data }
    delete old.perOpponentAccount
    delete old.pairs
    mount({ ...old, perAccount: [], recent: [] })
    for (const name of ['Мои аккаунты', 'Аккаунты соперника', 'Пары', 'Последние бои']) {
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument()
    }
  })

  it('keeps old-server recent rows without inventing opponent accounts', () => {
    const old = { ...data }
    delete old.perOpponentAccount
    delete old.pairs
    mount({ ...old, recent: [{ at, result: 'draw', accountTag: '#JCU' }] })
    const recent = within(screen.getByRole('region', { name: 'Последние бои' }))
    expect(recent.getByText('Мой основной')).toBeInTheDocument()
    expect(recent.queryByLabelText('против')).not.toBeInTheDocument()
  })

  it('does not show pairs for one owner and one opponent account', () => {
    mount()
    expect(screen.queryByRole('region', { name: 'Пары' })).not.toBeInTheDocument()
  })

  it.each(['owner', 'opponent'] as const)(
    'shows pairs with multiple %s accounts',
    (side) => {
      mount({
        ...data,
        perAccount:
          side === 'owner' ? [owner, { ...owner, accountTag: '#YQP' }] : [owner],
        perOpponentAccount:
          side === 'opponent' ? [opponent, { ...opponent, tag: '#YQP' }] : [opponent],
      })
      expect(screen.getByRole('region', { name: 'Пары' })).toBeInTheDocument()
    },
  )

  it('retains full names in tooltips and uses the truncating name class throughout details', () => {
    const name = 'Очень длинное имя аккаунта, которое не должно расширять карточку'
    mount({
      ...data,
      perAccount: [{ ...owner, alias: name }],
      perOpponentAccount: [{ ...opponent, name }],
      pairs: [
        { ...pair, ownerName: name },
        { ...pair, ownerTag: '#YQP', opponentName: name },
      ],
    })
    for (const label of screen.getAllByTitle(`${name} · #JCU`)) {
      expect(label.className).toContain('accountName')
    }
    expect(screen.getAllByTitle(`${name} · #PQL`).length).toBeGreaterThanOrEqual(2)
  })

  it('uses tags for unnamed profile-expanded accounts, including in compact rows', () => {
    render(
      <H2HBlock
        variant="panel"
        state={{ kind: 'data', data: { ...data, perAccount: [{ ...owner, alias: '' }] } }}
        onOpen={vi.fn()}
        onLinkAccount={vi.fn()}
      />,
    )
    expect(screen.getByText('#JCU')).toHaveAttribute('title', '#JCU')
  })

  it.each(['panel', 'line'] as const)(
    'keeps %s compact and limits account rows',
    (variant) => {
      render(
        <H2HBlock
          variant={variant}
          state={{
            kind: 'data',
            data: {
              ...data,
              perAccount: [
                owner,
                { ...owner, accountTag: '#YQP', alias: 'Второй' },
                { ...owner, accountTag: '#LQP', alias: 'Третий' },
              ],
            },
          }}
          onOpen={vi.fn()}
          onLinkAccount={vi.fn()}
        />,
      )
      expect(screen.queryByText('Третий')).not.toBeInTheDocument()
      expect(screen.queryByText('Аккаунты соперника')).not.toBeInTheDocument()
      expect(screen.getByText('по записанным боям Пути легенд')).toBeInTheDocument()
    },
  )

  it.each(['ok', 'none'] as const)(
    'qualifies %s for stale or incomplete records in card and both block variants',
    (status) => {
      for (const patch of [
        { stale: true },
        { coverage: { ...data.coverage, complete: false } },
      ]) {
        const state = { kind: 'data', data: { ...data, status, ...patch } } as const
        const view = render(
          <>
            <H2HCard state={state} onLinkAccount={vi.fn()} />
            <H2HBlock
              variant="panel"
              state={state}
              onOpen={vi.fn()}
              onLinkAccount={vi.fn()}
            />
            <H2HBlock
              variant="line"
              state={state}
              onOpen={vi.fn()}
              onLinkAccount={vi.fn()}
            />
          </>,
        )
        expect(
          screen.getAllByText('Данные могут быть неполными или не самыми свежими.'),
        ).toHaveLength(3)
        expect(screen.queryByText(/никогда/i)).not.toBeInTheDocument()
        view.unmount()
      }
    },
  )
})
