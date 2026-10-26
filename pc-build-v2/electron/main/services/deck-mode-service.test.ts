import { describe, expect, it, vi } from 'vitest'

import { ApiErrorSchema } from '../../../shared/errors/api-error'
import { EVENT_GONE_MESSAGE } from '../../../shared/contracts/game-events'
import { DeckModeService, preferencesFromServer } from './deck-mode-service'

function failure(status: number) {
  return {
    ok: false,
    error: ApiErrorSchema.parse({
      code: 'VALIDATION_FAILED',
      message: 'rejected',
      retryable: false,
      status,
    }),
  }
}

function service(result: unknown) {
  const request = vi.fn().mockResolvedValue(result)
  return { request, deckModes: new DeckModeService({ request } as never) }
}

describe('preferencesFromServer', () => {
  it('keeps the picked event only for a challenge', () => {
    expect(
      preferencesFromServer({
        deck_mode: 'challenge',
        event_tag: '#2PRCRPQL',
        event_title: 'Grand Challenge',
      }),
    ).toEqual({
      deckMode: 'challenge',
      event: { tag: '#2PRCRPQL', title: 'Grand Challenge' },
    })
    expect(preferencesFromServer({ deck_mode: 'gt', event_tag: '#2PRCRPQL' })).toEqual({
      deckMode: 'gt',
      event: null,
    })
  })

  it('reads an unknown mode as Path of Legends', () => {
    expect(preferencesFromServer({ deck_mode: 'ladder' })).toEqual({
      deckMode: 'pol',
      event: null,
    })
  })
})

describe('DeckModeService', () => {
  it('saves a challenge with its event tag and returns what the server holds', async () => {
    const { request, deckModes } = service({
      ok: true,
      status: 200,
      data: {
        deck_mode: 'challenge',
        event_tag: '#2PRCRPQL',
        event_title: 'Grand Challenge',
      },
    })
    await expect(
      deckModes.save({
        deckMode: 'challenge',
        event: { tag: '#2PRCRPQL', title: 'Grand Challenge' },
      }),
    ).resolves.toEqual({
      deckMode: 'challenge',
      event: { tag: '#2PRCRPQL', title: 'Grand Challenge' },
    })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PUT',
        path: '/api/webapp/settings',
        body: { deck_mode: 'challenge', event_tag: '#2PRCRPQL' },
      }),
    )
  })

  it('sends no event for Path of Legends', async () => {
    const { request, deckModes } = service({
      ok: true,
      status: 200,
      data: { deck_mode: 'pol' },
    })
    await deckModes.save({ deckMode: 'pol', event: { tag: '#2PRCRPQL', title: 'Old' } })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ body: { deck_mode: 'pol' } }),
    )
  })

  it('tells an event that left the game from other failures', async () => {
    const gone = service(failure(400)).deckModes
    await expect(
      gone.save({ deckMode: 'challenge', event: { tag: '#2PRCRPQL', title: 'Grand' } }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_AVAILABLE', message: EVENT_GONE_MESSAGE })
    const down = service(failure(503)).deckModes
    await expect(down.save({ deckMode: 'gt' })).rejects.toMatchObject({
      code: 'DECK_MODE_SAVE_FAILED',
    })
  })

  it('lists no events when the server does not answer', async () => {
    await expect(service(failure(503)).deckModes.listEvents()).resolves.toBeNull()
    await expect(service(failure(503)).deckModes.read()).resolves.toBeNull()
  })
})
