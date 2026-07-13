import { describe, expect, it, vi } from 'vitest'

import type { MonitorResult } from '../../../shared/models/monitor'
import { ImageAssetService } from './image-asset-service'

const RESULT_ID = '29d970c1-fc4f-4bea-a767-8f108d3b8739'

function png(width = 32, height = 40): Buffer {
  const value = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value)
  value.write('IHDR', 12, 'ascii')
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

function result(iconUrl: string): MonitorResult {
  return {
    id: RESULT_ID,
    kind: 'player_found',
    timestamp: '2026-07-12T12:00:00.000Z',
    searchMode: 'fast',
    deckMode: 'pol',
    searchedNickname: null,
    player: { name: 'Player', tag: null, rating: null, clan: null },
    decks: [
      {
        label: null,
        cards: [{ name: 'Knight', level: null, evolutionLevel: null, iconUrl }],
      },
    ],
  }
}

const request = { resultId: RESULT_ID, deckIndex: 0, cardIndex: 0 }

describe('ImageAssetService', () => {
  it('rejects SSRF hosts and cross-host redirects before downloading them', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const untrusted = new ImageAssetService(
      { getRetainedResult: () => result('https://127.0.0.1/card.png') },
      fetchImplementation,
    )
    await expect(untrusted.getCardAsset(request)).resolves.toEqual({
      kind: 'unavailable',
    })
    expect(fetchImplementation).not.toHaveBeenCalled()

    const nonDefaultPort = new ImageAssetService(
      {
        getRetainedResult: () =>
          result('https://api-assets.clashroyale.com:8443/card.png'),
      },
      fetchImplementation,
    )
    await expect(nonDefaultPort.getCardAsset(request)).resolves.toEqual({
      kind: 'unavailable',
    })
    expect(fetchImplementation).not.toHaveBeenCalled()

    fetchImplementation.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/card.png' },
      }),
    )
    const redirected = new ImageAssetService(
      {
        getRetainedResult: () => result('https://api-assets.clashroyale.com/card.png'),
      },
      fetchImplementation,
    )
    await expect(redirected.getCardAsset(request)).resolves.toEqual({
      kind: 'unavailable',
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized, wrong-content-type, and excessive-dimension assets', async () => {
    const retained = {
      getRetainedResult: () => result('https://api-assets.clashroyale.com/card.png'),
    }
    for (const response of [
      new Response(Uint8Array.from(png()), {
        headers: {
          'content-type': 'image/png',
          'content-length': String(512 * 1024 + 1),
        },
      }),
      new Response(Uint8Array.from(png()), { headers: { 'content-type': 'text/html' } }),
      new Response(Uint8Array.from(png(3000, 20)), {
        headers: { 'content-type': 'image/png' },
      }),
    ]) {
      const service = new ImageAssetService(
        retained,
        vi.fn<typeof fetch>().mockResolvedValue(response),
      )
      await expect(service.getCardAsset(request)).resolves.toEqual({
        kind: 'unavailable',
      })
    }
  })

  it('returns a bounded data URL and reuses the in-memory cache', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Uint8Array.from(png()), {
        headers: { 'content-type': 'image/png' },
      }),
    )
    const service = new ImageAssetService(
      {
        getRetainedResult: () =>
          result('https://api-assets.clashroyale.com/cards/knight.png'),
      },
      fetchImplementation,
    )
    const first = await service.getCardAsset(request)
    await expect(service.getCardAsset(request)).resolves.toEqual(first)
    expect(first).toMatchObject({ kind: 'available' })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    const calls = JSON.stringify(fetchImplementation.mock.calls)
    expect(calls).not.toContain(png().toString('base64'))
  })

  it('coalesces concurrent requests for the same retained asset URL', async () => {
    let release!: (response: Response) => void
    const fetchImplementation = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    const service = new ImageAssetService(
      {
        getRetainedResult: () =>
          result('https://api-assets.clashroyale.com/cards/knight.png'),
      },
      fetchImplementation,
    )
    const first = service.getCardAsset(request)
    const second = service.getCardAsset(request)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    release(
      new Response(Uint8Array.from(png()), {
        headers: { 'content-type': 'image/png' },
      }),
    )
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'available' }),
      expect.objectContaining({ kind: 'available' }),
    ])
  })

  it('caps global network concurrency at four', async () => {
    const cards = Array.from({ length: 6 }, (_, index) => ({
      name: `Card ${index}`,
      level: null,
      evolutionLevel: null,
      iconUrl: `https://api-assets.clashroyale.com/cards/${index}.png`,
    }))
    const retained = result(cards[0]?.iconUrl ?? '')
    if (retained.kind !== 'player_found') throw new Error('Expected found result')
    retained.decks[0] = { label: null, cards }
    let active = 0
    let maximum = 0
    const releases: ((response: Response) => void)[] = []
    const fetchImplementation = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          active += 1
          maximum = Math.max(maximum, active)
          releases.push((response) => {
            active -= 1
            resolve(response)
          })
        }),
    )
    const service = new ImageAssetService(
      { getRetainedResult: () => retained },
      fetchImplementation,
    )
    const operations = cards.map((_, cardIndex) =>
      service.getCardAsset({ ...request, cardIndex }),
    )
    expect(fetchImplementation).toHaveBeenCalledTimes(4)
    for (const release of releases.splice(0)) {
      release(
        new Response(Uint8Array.from(png()), {
          headers: { 'content-type': 'image/png' },
        }),
      )
    }
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(6))
    for (const release of releases.splice(0)) {
      release(
        new Response(Uint8Array.from(png()), {
          headers: { 'content-type': 'image/png' },
        }),
      )
    }
    await Promise.all(operations)
    expect(maximum).toBe(4)
  })

  it('aborts all active fetches when stopped', async () => {
    let aborted = false
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('stopped', 'AbortError'))
          })
        }),
    )
    const service = new ImageAssetService(
      { getRetainedResult: () => result('https://api-assets.clashroyale.com/card.png') },
      fetchImplementation,
    )
    const operation = service.getCardAsset(request)
    service.stop()
    await expect(operation).resolves.toEqual({ kind: 'unavailable' })
    expect(aborted).toBe(true)
  })

  it('requires exact retained indices and accepts no renderer URL field', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const service = new ImageAssetService(
      { getRetainedResult: () => result('https://api-assets.clashroyale.com/card.png') },
      fetchImplementation,
    )
    await expect(service.getCardAsset({ ...request, cardIndex: 7 })).resolves.toEqual({
      kind: 'unavailable',
    })
    await expect(
      service.getCardAsset({
        ...request,
        url: 'https://api-assets.clashroyale.com/card.png',
      } as never),
    ).rejects.toThrow()
  })
})
