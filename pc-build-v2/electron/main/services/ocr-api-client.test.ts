import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProductionServerConfig } from '../infrastructure/server-config'
import { normalizeOcrResponse, OcrApiClient } from './ocr-api-client'

const requestMeta = {
  timestamp: '2026-07-12T12:00:00.000Z',
  searchMode: 'fast' as const,
  deckMode: 'pol' as const,
}

function png(width = 20, height = 10): Buffer {
  const value = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value)
  value.write('IHDR', 12, 'ascii')
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

function logger() {
  return { debug: vi.fn(), warn: vi.fn() }
}

function response(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    ...(headers === undefined ? {} : { headers }),
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeOcrResponse', () => {
  it('preserves bounded player and deck data', () => {
    const result = normalizeOcrResponse(
      {
        success: true,
        searched_nickname: 'Opponent',
        player: { name: 'Opponent', tag: '#ABC', rating: 2345, clan_name: 'Clan' },
        decks: [
          {
            mode: 'PoL',
            cards: [
              {
                name: 'Knight',
                level: 14,
                evolution_level: 1,
                icon_url: 'https://cdn.test/card.png',
              },
            ],
          },
        ],
      },
      requestMeta,
    )
    expect(result).toMatchObject({
      kind: 'player_found',
      player: { name: 'Opponent', tag: '#ABC', rating: 2345, clan: 'Clan' },
      decks: [{ label: 'PoL', cards: [{ name: 'Knight' }] }],
    })
    expect(result).not.toHaveProperty('rawResponse')
  })

  it('keeps legitimate not-found separate from recognition and service failures', () => {
    expect(
      normalizeOcrResponse(
        { success: false, player_not_found: true, searched_nickname: 'Ghost' },
        requestMeta,
      ).kind,
    ).toBe('player_not_found')
    expect(
      normalizeOcrResponse(
        { success: false, error: 'unreadable', ocr_result: { found: false } },
        requestMeta,
      ).kind,
    ).toBe('recognition_failed')
    expect(normalizeOcrResponse({ success: true }, requestMeta).kind).toBe(
      'service_error',
    )
  })
})

describe('OcrApiClient', () => {
  it('posts fixed bounded multipart fields and refreshes once after 401', async () => {
    const tokens = { old: 'old-token', fresh: 'new-token' }
    const getAccessToken = vi.fn((force = false) =>
      Promise.resolve(force ? tokens.fresh : tokens.old),
    )
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(
        response({ success: true, player: { name: 'Player', tag: '#TAG' }, decks: [] }),
      )
    const log = logger()
    const client = new OcrApiClient(
      fetchImplementation,
      { getAccessToken },
      createProductionServerConfig(),
      log,
    )
    const result = await client.process({
      ...requestMeta,
      image: png(),
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('player_found')
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      'https://api.artcsworld.xyz/api/ocr/process',
    )
    const secondInit = fetchImplementation.mock.calls[1]?.[1]
    expect(new Headers(secondInit?.headers).get('authorization')).toBe('Bearer new-token')
    const form = secondInit?.body
    expect(form).toBeInstanceOf(FormData)
    if (!(form instanceof FormData)) throw new Error('missing form')
    expect(form.get('timestamp')).toBe(requestMeta.timestamp)
    expect(form.get('search_mode')).toBe('fast')
    expect(form.get('deck_mode')).toBe('pol')
    const logged = JSON.stringify([...log.debug.mock.calls, ...log.warn.mock.calls])
    expect(logged).not.toContain('old-token')
    expect(logged).not.toContain('new-token')
    expect(logged).not.toContain(png().toString('base64'))
  })

  it('reports auth blocking, oversized responses, and network errors as service errors', async () => {
    const auth = { getAccessToken: vi.fn().mockResolvedValue('token') }
    for (const [fetchImplementation, expected] of [
      [vi.fn<typeof fetch>().mockResolvedValue(response({}, 403)), true],
      [
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response({}, 200, { 'content-length': String(1024 * 1024 + 1) }),
          ),
        false,
      ],
      [vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')), false],
    ] as const) {
      const client = new OcrApiClient(
        fetchImplementation,
        auth,
        createProductionServerConfig(),
        logger(),
      )
      const result = await client.process({
        ...requestMeta,
        image: png(),
        signal: new AbortController().signal,
      })
      expect(result.kind).toBe('service_error')
      if (result.kind === 'service_error') expect(result.authBlocked).toBe(expected)
    }
  })

  it('distinguishes the 150 second timeout from owner cancellation', async () => {
    vi.useFakeTimers()
    const fetchImplementation = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted === true) {
            reject(new Error('aborted'))
            return
          }
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        }),
    )
    const client = new OcrApiClient(
      fetchImplementation,
      { getAccessToken: vi.fn().mockResolvedValue('token') },
      createProductionServerConfig(),
      logger(),
    )
    const timeoutResult = client.process({
      ...requestMeta,
      image: png(),
      signal: new AbortController().signal,
    })
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(150_000)
    await expect(timeoutResult).resolves.toMatchObject({
      kind: 'service_error',
      retryable: true,
    })

    const owner = new AbortController()
    const cancelled = client.process({
      ...requestMeta,
      image: png(),
      signal: owner.signal,
    })
    owner.abort()
    await expect(cancelled).resolves.toMatchObject({
      kind: 'service_error',
      retryable: false,
    })
  })
})
