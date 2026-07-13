import { describe, expect, it, vi } from 'vitest'

import type { AuthUserView } from '../../../shared/models/auth'
import {
  MonitorResultSchema,
  type MonitorPreferences,
} from '../../../shared/models/monitor'
import type { ReprocessedEventData } from './websocket-session'
import { ReprocessedResultService } from './reprocessed-result-service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function harness() {
  let listener: ((data: ReprocessedEventData) => void | Promise<void>) | null = null
  let user: AuthUserView | null = {
    id: '42',
    username: 'operator',
    email: 'operator@example.com',
    role: 'premium',
    roles: ['premium'],
  }
  const monitor = {
    getPreferences: vi
      .fn<() => Promise<MonitorPreferences>>()
      .mockResolvedValue({ searchMode: 'fast', deckMode: 'pol' }),
    addExternalResult: vi.fn<(result: unknown) => void>(),
  }
  const service = new ReprocessedResultService(
    {
      subscribeReprocessed: (next) => {
        listener = next
        return () => {
          listener = null
        }
      },
    },
    {
      getView: () => ({
        state: user === null ? ('UNAUTHENTICATED' as const) : ('AUTHENTICATED' as const),
        user,
        deviceHint: null,
        error: null,
      }),
    },
    monitor,
    () => new Date('2026-07-12T12:00:00.000Z'),
  )
  return {
    service,
    monitor,
    emit: (data: ReprocessedEventData) => listener?.(data),
    loseAuth: () => {
      user = null
    },
  }
}

describe('ReprocessedResultService', () => {
  it('normalizes valid events with current preferences and emits only the safe result DTO', async () => {
    const test = harness()
    test.service.start('42')
    await test.emit({
      success: true,
      searched_nickname: 'Opponent',
      player: { name: 'Opponent', tag: '#ABC', model: 'private' },
      decks: [],
      raw: 'private',
      image_base64: 'private',
      source_url: 'https://private.example/data',
    })
    expect(test.monitor.addExternalResult).toHaveBeenCalledTimes(1)
    const safeResult = MonitorResultSchema.parse(
      test.monitor.addExternalResult.mock.calls[0]?.[0],
    )
    expect(safeResult).toEqual({
      id: safeResult.id,
      kind: 'player_found',
      timestamp: '2026-07-12T12:00:00.000Z',
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: 'Opponent',
      player: { name: 'Opponent', tag: '#ABC', rating: null, clan: null },
      decks: [],
    })
    expect(safeResult.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(safeResult).not.toHaveProperty('raw')
    expect(safeResult).not.toHaveProperty('image_base64')
    expect(safeResult).not.toHaveProperty('source_url')
    if (safeResult.kind !== 'player_found') throw new Error('Expected player result')
    expect(safeResult.player).not.toHaveProperty('model')
  })

  it('fences an event whose preference load completes after auth loss', async () => {
    const test = harness()
    const preferences = deferred<{ searchMode: 'fast'; deckMode: 'pol' }>()
    test.monitor.getPreferences.mockReturnValueOnce(preferences.promise)
    test.service.start('42')
    const processing = test.emit({
      success: true,
      player: { name: 'Stale player' },
      decks: [],
    })
    test.loseAuth()
    test.service.stop()
    preferences.resolve({ searchMode: 'fast', deckMode: 'pol' })
    await processing
    expect(test.monitor.addExternalResult).not.toHaveBeenCalled()
  })
})
