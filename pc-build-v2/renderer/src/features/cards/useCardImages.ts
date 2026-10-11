import { useEffect, useMemo, useState } from 'react'

import type {
  CardAssetRequest,
  CardAssetResult,
} from '../../../../shared/contracts/widget-ipc'

export type CardAssetFetcher = (request: CardAssetRequest) => Promise<CardAssetResult>

export interface CardImage {
  /** Displayable data URL, or null (no art, not fetched yet, or unavailable). */
  src: string | null
  /** A fetch or a scheduled retry is still outstanding. */
  pending: boolean
}

const RETRY_DELAYS_MS = [250, 750, 1_500] as const

interface Loaded {
  key: string
  sources: (string | null)[]
  settled: boolean[]
}

/**
 * Card art of one deck, fetched through the narrow card-asset capability by result
 * reference (never by URL). A card may not be retained/cached yet, so an unavailable or
 * failed answer is retried a few times; everything is cancelled on deck change/unmount.
 */
export function useCardImages(
  resultId: string | null,
  deckIndex: number,
  hasImage: readonly boolean[],
  fetchAsset: CardAssetFetcher,
): CardImage[] {
  const signature = hasImage.map((flag) => (flag ? '1' : '0')).join('')
  const key = `${resultId ?? ''}:${deckIndex}:${signature}`
  const [loaded, setLoaded] = useState<Loaded>({ key: '', sources: [], settled: [] })

  useEffect(() => {
    if (resultId === null) return
    const cancellation = new AbortController()
    const timers = new Set<number>()
    const wanted = signature.split('').map((flag) => flag === '1')

    const publish = (index: number, src: string | null, settled: boolean): void => {
      if (cancellation.signal.aborted) return
      setLoaded((current) => {
        const base: Loaded =
          current.key === key
            ? current
            : {
                key,
                sources: wanted.map(() => null),
                settled: wanted.map((flag) => !flag),
              }
        const sources = [...base.sources]
        const flags = [...base.settled]
        sources[index] = src
        flags[index] = settled
        return { key, sources, settled: flags }
      })
    }

    const wait = (delay: number): Promise<undefined> => {
      const { promise, resolve } = Promise.withResolvers<undefined>()
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        resolve(undefined)
      }, delay)
      timers.add(timer)
      return promise
    }

    const request = async (index: number): Promise<string | null> => {
      try {
        const asset = await fetchAsset({ resultId, deckIndex, cardIndex: index })
        return asset.kind === 'available' ? asset.dataUrl : null
      } catch {
        return null
      }
    }

    const cancelled = (): boolean => cancellation.signal.aborted
    const load = async (index: number): Promise<void> => {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        const delay = RETRY_DELAYS_MS[attempt - 1]
        if (delay !== undefined) await wait(delay)
        if (cancelled()) return
        const src = await request(index)
        if (cancelled()) return
        if (src !== null || attempt === RETRY_DELAYS_MS.length) {
          publish(index, src, true)
          return
        }
      }
    }

    wanted.forEach((flag, index) => {
      if (flag) void load(index)
    })
    return () => {
      cancellation.abort()
      for (const timer of timers) window.clearTimeout(timer)
      timers.clear()
    }
  }, [resultId, deckIndex, signature, key, fetchAsset])

  return useMemo(
    () =>
      hasImage.map((flag, index) => {
        if (!flag) return { src: null, pending: false }
        if (loaded.key !== key) return { src: null, pending: resultId !== null }
        return {
          src: loaded.sources[index] ?? null,
          pending: loaded.settled[index] !== true,
        }
      }),
    // `hasImage` is represented by `signature` inside `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, key, resultId],
  )
}
