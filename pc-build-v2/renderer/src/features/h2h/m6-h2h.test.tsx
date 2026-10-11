// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H2HData } from './useH2H'
import { H2HBlock } from './H2HBlock'
import { H2HCard } from './H2HCard'

afterEach(cleanup)
const data: H2HData = {
  status: 'none',
  opponent: { tag: '#2Q8YLP0', name: null },
  scope: 'recorded_path_of_legends',
  coverage: { source: 'cr_stats_current_and_archives', complete: true },
  updatedAt: '2026-10-10T12:00:00.000Z',
  stale: false,
  totals: {
    meetings: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    decisiveMeetings: 0,
    winRate: null,
  },
  last: null,
  recent: [],
  perAccount: [],
}
describe('M6 H2H review', () => {
  it.each([{ stale: true }, { coverage: { ...data.coverage, complete: false } }])(
    '#12 qualifies zero meetings when records are stale or incomplete: %j',
    (patch) => {
      const state = { kind: 'data', data: { ...data, ...patch } } as const
      render(
        <>
          <H2HCard state={state} onLinkAccount={vi.fn()} />
          <H2HBlock
            state={state}
            onLinkAccount={vi.fn()}
            onOpen={vi.fn()}
            variant="panel"
          />
        </>,
      )
      expect(
        screen.getAllByText('Данные могут быть неполными или не самыми свежими.'),
      ).toHaveLength(2)
    },
  )
  it('#13 distinguishes a server unavailable response from a transport failure', () => {
    const state = { kind: 'data', data: { ...data, status: 'unavailable' } } as const
    render(
      <>
        <H2HCard state={state} onLinkAccount={vi.fn()} />
        <H2HBlock
          state={state}
          onLinkAccount={vi.fn()}
          onOpen={vi.fn()}
          variant="panel"
        />
      </>,
    )
    expect(screen.getAllByText(/Сервис личных встреч временно недоступен/)).toHaveLength(
      2,
    )
    expect(screen.queryByText(/Сервер не ответил/)).not.toBeInTheDocument()
  })
})
