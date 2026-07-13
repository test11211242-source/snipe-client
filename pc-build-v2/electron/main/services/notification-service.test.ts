import { describe, expect, it, vi } from 'vitest'

import type { MonitorResult } from '../../../shared/models/monitor'
import { NotificationService } from './notification-service'

const found: MonitorResult = {
  id: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
  kind: 'player_found',
  timestamp: '2026-07-12T12:00:00.000Z',
  searchMode: 'fast',
  deckMode: 'pol',
  searchedNickname: null,
  player: { name: 'Player\nName', tag: '#TAG', rating: 2000, clan: 'Safe Clan' },
  decks: [
    {
      label: null,
      cards: [
        {
          name: 'Knight',
          level: null,
          evolutionLevel: null,
          iconUrl: 'https://api-assets.clashroyale.com/private.png?token=secret',
        },
      ],
    },
  ],
}

describe('NotificationService', () => {
  it('notifies once with bounded safe text and no card data', () => {
    let listener: ((result: MonitorResult) => void) | undefined
    const show = vi.fn()
    const create = vi.fn(() => ({ show }))
    const service = new NotificationService(
      {
        subscribeResults: (next) => {
          listener = (result) => {
            void Promise.resolve(next(result))
          }
          return vi.fn()
        },
      },
      () => true,
      create,
    )
    service.start()
    listener?.(found)
    listener?.(found)
    expect(show).toHaveBeenCalledTimes(1)
    const serialized = JSON.stringify(create.mock.calls)
    expect(serialized).toContain('Player Name')
    expect(serialized).not.toMatch(/api-assets|token|secret|Knight/)
  })

  it('honors support, enabled, and stop lifecycle checks', () => {
    let listener: ((result: MonitorResult) => void) | undefined
    const dispose = vi.fn()
    const create = vi.fn(() => ({ show: vi.fn() }))
    let enabled = false
    const service = new NotificationService(
      {
        subscribeResults: (next) => {
          listener = (result) => {
            void Promise.resolve(next(result))
          }
          return dispose
        },
      },
      () => true,
      create,
      () => enabled,
    )
    service.start()
    listener?.(found)
    enabled = true
    listener?.(found)
    expect(create).toHaveBeenCalledTimes(1)
    service.stop()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
