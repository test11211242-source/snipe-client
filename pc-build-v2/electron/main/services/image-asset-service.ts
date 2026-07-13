import {
  CardAssetRequestSchema,
  CardAssetResultSchema,
  type CardAssetRequest,
  type CardAssetResult,
} from '../../../shared/contracts/widget-ipc'
import type { MonitorSupervisor } from './monitor-supervisor'

const ALLOWED_ASSET_HOSTS = new Set(['api-assets.clashroyale.com'])
const MAX_ASSET_BYTES = 512 * 1024
const MAX_ASSET_DIMENSION = 2048
const MAX_ASSET_PIXELS = 4_000_000
const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_BYTES = 8 * 1024 * 1024
const FETCH_TIMEOUT_MS = 5_000
const MAX_REDIRECTS = 2
const MAX_CONCURRENT_FETCHES = 4
const MAX_WAITING_FETCHES = 32

interface CachedAsset {
  bytes: Buffer
  mimeType: string
}

interface AssetWaiter {
  generation: number
  task: () => Promise<CardAssetResult>
  resolve: (result: CardAssetResult) => void
}

function allowedUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      ALLOWED_ASSET_HOSTS.has(url.host) &&
      url.username.length === 0 &&
      url.password.length === 0
      ? url
      : null
  } catch {
    return null
  }
}

async function boundedBytes(response: Response): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let completed = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(next.value)
    }
    completed = true
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    if (marker === undefined) return null
    offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return null
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) return null
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      }
    }
    offset += length
  }
  return null
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null
  }
  const type = bytes.subarray(12, 16).toString('ascii')
  if (type === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  }
  if (type === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  if (type === 'VP8L' && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21)
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
  }
  return null
}

function dimensions(
  bytes: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  if (mimeType === 'image/png') {
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
    ) {
      return null
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mimeType === 'image/jpeg') return jpegDimensions(bytes)
  if (mimeType === 'image/webp') return webpDimensions(bytes)
  return null
}

export class ImageAssetService {
  readonly #cache = new Map<string, CachedAsset>()
  readonly #inFlight = new Map<string, Promise<CardAssetResult>>()
  readonly #controllers = new Set<AbortController>()
  readonly #waiters: AssetWaiter[] = []
  #cacheBytes = 0
  #activeFetches = 0
  #generation = 0

  constructor(
    private readonly monitor: Pick<MonitorSupervisor, 'getRetainedResult'>,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
  ) {}

  async getCardAsset(rawRequest: CardAssetRequest): Promise<CardAssetResult> {
    const request = CardAssetRequestSchema.parse(rawRequest)
    const result = this.monitor.getRetainedResult(request.resultId)
    if (result?.kind !== 'player_found') return { kind: 'unavailable' }
    const iconUrl = result.decks[request.deckIndex]?.cards[request.cardIndex]?.iconUrl
    if (iconUrl === null || iconUrl === undefined) return { kind: 'unavailable' }
    const initialUrl = allowedUrl(iconUrl)
    if (initialUrl === null) return { kind: 'unavailable' }

    const cached = this.#cache.get(initialUrl.href)
    if (cached !== undefined) {
      this.#cache.delete(initialUrl.href)
      this.#cache.set(initialUrl.href, cached)
      return this.available(cached)
    }

    const existing = this.#inFlight.get(initialUrl.href)
    if (existing !== undefined) return existing
    const generation = this.#generation
    const operation = this.schedule(
      () => this.fetchAsset(initialUrl, generation),
      generation,
    ).finally(() => {
      if (this.#inFlight.get(initialUrl.href) === operation) {
        this.#inFlight.delete(initialUrl.href)
      }
    })
    this.#inFlight.set(initialUrl.href, operation)
    return operation
  }

  stop(): void {
    ++this.#generation
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ kind: 'unavailable' })
    }
    this.#inFlight.clear()
    this.#cache.clear()
    this.#cacheBytes = 0
  }

  private async fetchAsset(
    initialUrl: URL,
    generation: number,
  ): Promise<CardAssetResult> {
    if (generation !== this.#generation) return { kind: 'unavailable' }
    const controller = new AbortController()
    this.#controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      let currentUrl = initialUrl
      let response: Response | null = null
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        response = await this.fetchImplementation(currentUrl, {
          method: 'GET',
          headers: { Accept: 'image/png, image/jpeg, image/webp' },
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (response.status < 300 || response.status >= 400) break
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (location === null || redirect === MAX_REDIRECTS)
          return { kind: 'unavailable' }
        const redirected = allowedUrl(new URL(location, currentUrl).href)
        if (redirected === null) return { kind: 'unavailable' }
        currentUrl = redirected
      }
      if (!response?.ok) {
        await response?.body?.cancel().catch(() => undefined)
        return { kind: 'unavailable' }
      }
      if (response.url.length > 0 && allowedUrl(response.url) === null) {
        await response.body?.cancel().catch(() => undefined)
        return { kind: 'unavailable' }
      }
      const mimeType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase()
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType ?? '')) {
        await response.body?.cancel().catch(() => undefined)
        return { kind: 'unavailable' }
      }
      const bytes = await boundedBytes(response)
      if (bytes === null || mimeType === undefined) return { kind: 'unavailable' }
      const size = dimensions(bytes, mimeType)
      if (
        size === null ||
        size.width < 1 ||
        size.height < 1 ||
        size.width > MAX_ASSET_DIMENSION ||
        size.height > MAX_ASSET_DIMENSION ||
        size.width * size.height > MAX_ASSET_PIXELS
      ) {
        return { kind: 'unavailable' }
      }
      const asset = { bytes, mimeType }
      if (generation !== this.#generation) return { kind: 'unavailable' }
      this.insertCache(initialUrl.href, asset)
      return this.available(asset)
    } catch {
      return { kind: 'unavailable' }
    } finally {
      clearTimeout(timer)
      this.#controllers.delete(controller)
    }
  }

  private schedule(
    task: () => Promise<CardAssetResult>,
    generation: number,
  ): Promise<CardAssetResult> {
    return new Promise((resolve) => {
      const waiter = { generation, task, resolve }
      if (this.#activeFetches < MAX_CONCURRENT_FETCHES) this.run(waiter)
      else if (this.#waiters.length >= MAX_WAITING_FETCHES)
        resolve({ kind: 'unavailable' })
      else this.#waiters.push(waiter)
    })
  }

  private run(waiter: AssetWaiter): void {
    if (waiter.generation !== this.#generation) {
      waiter.resolve({ kind: 'unavailable' })
      return
    }
    this.#activeFetches += 1
    void waiter
      .task()
      .then(waiter.resolve, () => waiter.resolve({ kind: 'unavailable' }))
      .finally(() => {
        this.#activeFetches -= 1
        for (;;) {
          const next = this.#waiters.shift()
          if (next === undefined) break
          if (next.generation === this.#generation) {
            this.run(next)
            break
          }
          next.resolve({ kind: 'unavailable' })
        }
      })
  }

  private available(asset: CachedAsset): CardAssetResult {
    return CardAssetResultSchema.parse({
      kind: 'available',
      dataUrl: `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`,
    })
  }

  private insertCache(key: string, asset: CachedAsset): void {
    if (asset.bytes.byteLength > MAX_CACHE_BYTES) return
    const previous = this.#cache.get(key)
    if (previous !== undefined) this.#cacheBytes -= previous.bytes.byteLength
    this.#cache.set(key, asset)
    this.#cacheBytes += asset.bytes.byteLength
    while (this.#cache.size > MAX_CACHE_ENTRIES || this.#cacheBytes > MAX_CACHE_BYTES) {
      const oldest = this.#cache.entries().next().value
      if (oldest === undefined) break
      this.#cache.delete(oldest[0])
      this.#cacheBytes -= oldest[1].bytes.byteLength
    }
  }
}
