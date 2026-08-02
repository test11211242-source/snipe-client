import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
const MAX_CONCURRENT_FETCHES = 10
const MAX_WAITING_FETCHES = 32
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_MANIFEST_ASSETS = 512
const MANIFEST_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000
const BACKGROUND_FETCHES = 2
const FAILURE_CACHE_MS = 2_000
const MAX_FAILURE_CACHE_ENTRIES = 512

export interface ImageAssetPersistence {
  cacheDirectory: string
  versionUrl: string
  manifestUrl: string
}

interface CachedAsset {
  bytes: Buffer
  mimeType: string
}

interface AssetWaiter {
  generation: number
  task: () => Promise<CardAssetResult>
  resolve: (result: CardAssetResult) => void
}

interface PersistentAssetMetadata {
  url: string
  mimeType: string
}

interface ManifestState {
  version: number
  contentHash: string
  checkedAt: number
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function boundedBytes(
  response: Response,
  limit = MAX_ASSET_BYTES,
): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
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
      if (total > limit) {
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

function manifestState(value: unknown): ManifestState | null {
  const item = record(value)
  const version = Number(item?.['version'])
  const contentHash = item?.['contentHash']
  const checkedAt = Number(item?.['checkedAt'])
  return Number.isSafeInteger(version) &&
    version >= 0 &&
    typeof contentHash === 'string' &&
    contentHash.length <= 160 &&
    Number.isFinite(checkedAt) &&
    checkedAt >= 0
    ? { version, contentHash, checkedAt }
    : null
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
  readonly #failedUntil = new Map<string, number>()
  readonly #controllers = new Set<AbortController>()
  readonly #waiters: AssetWaiter[] = []
  #cacheBytes = 0
  #activeFetches = 0
  #generation = 0
  #warmPromise: Promise<void> | null = null

  constructor(
    private readonly monitor: Pick<MonitorSupervisor, 'getRetainedResult'>,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
    private readonly persistence: ImageAssetPersistence | null = null,
  ) {}

  start(): Promise<void> {
    if (this.persistence === null) return Promise.resolve()
    if (this.#warmPromise !== null) return this.#warmPromise
    const generation = this.#generation
    const operation = this.warmPersistentCache(generation).finally(() => {
      if (this.#warmPromise === operation) this.#warmPromise = null
    })
    this.#warmPromise = operation
    return operation
  }

  async getCardAsset(rawRequest: CardAssetRequest): Promise<CardAssetResult> {
    const request = CardAssetRequestSchema.parse(rawRequest)
    const result = this.monitor.getRetainedResult(request.resultId)
    if (result?.kind !== 'player_found') return { kind: 'unavailable' }
    const iconUrl = result.decks[request.deckIndex]?.cards[request.cardIndex]?.iconUrl
    if (iconUrl === null || iconUrl === undefined) return { kind: 'unavailable' }
    const initialUrl = allowedUrl(iconUrl)
    if (initialUrl === null) return { kind: 'unavailable' }

    return this.getUrlAsset(initialUrl, true)
  }

  private getUrlAsset(initialUrl: URL, foreground: boolean): Promise<CardAssetResult> {
    const cached = this.#cache.get(initialUrl.href)
    if (cached !== undefined) {
      this.#cache.delete(initialUrl.href)
      this.#cache.set(initialUrl.href, cached)
      return Promise.resolve(this.available(cached))
    }

    if ((this.#failedUntil.get(initialUrl.href) ?? 0) > Date.now()) {
      return Promise.resolve({ kind: 'unavailable' })
    }
    this.#failedUntil.delete(initialUrl.href)

    const existing = this.#inFlight.get(initialUrl.href)
    if (existing !== undefined) return existing
    const generation = this.#generation
    const operation = this.schedule(
      () => this.loadAsset(initialUrl, generation),
      generation,
      foreground,
    )
      .then((result) => {
        if (generation !== this.#generation) return result
        if (result.kind === 'available') this.#failedUntil.delete(initialUrl.href)
        else {
          this.#failedUntil.delete(initialUrl.href)
          this.#failedUntil.set(initialUrl.href, Date.now() + FAILURE_CACHE_MS)
          while (this.#failedUntil.size > MAX_FAILURE_CACHE_ENTRIES) {
            const oldest = this.#failedUntil.keys().next().value
            if (oldest === undefined) break
            this.#failedUntil.delete(oldest)
          }
        }
        return result
      })
      .finally(() => {
        if (this.#inFlight.get(initialUrl.href) === operation) {
          this.#inFlight.delete(initialUrl.href)
        }
      })
    this.#inFlight.set(initialUrl.href, operation)
    return operation
  }

  stop(): void {
    ++this.#generation
    this.#warmPromise = null
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ kind: 'unavailable' })
    }
    this.#inFlight.clear()
    this.#failedUntil.clear()
    this.#cache.clear()
    this.#cacheBytes = 0
  }

  private async loadAsset(initialUrl: URL, generation: number): Promise<CardAssetResult> {
    if (this.persistence === null) return this.fetchAsset(initialUrl, generation)
    const persistent = await this.readPersistent(initialUrl)
    if (generation !== this.#generation) return { kind: 'unavailable' }
    if (persistent !== null) {
      this.insertCache(initialUrl.href, persistent)
      return this.available(persistent)
    }
    return this.fetchAsset(initialUrl, generation)
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
      await this.writePersistent(initialUrl, asset)
      if (generation !== this.#generation) return { kind: 'unavailable' }
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
    foreground: boolean,
  ): Promise<CardAssetResult> {
    return new Promise((resolve) => {
      const waiter = { generation, task, resolve }
      if (this.#activeFetches < MAX_CONCURRENT_FETCHES) this.run(waiter)
      else if (this.#waiters.length >= MAX_WAITING_FETCHES)
        resolve({ kind: 'unavailable' })
      else if (foreground) this.#waiters.unshift(waiter)
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

  private persistentPaths(url: URL): {
    asset: string
    metadata: string
  } | null {
    if (this.persistence === null) return null
    const key = createHash('sha256').update(url.href).digest('hex')
    return {
      asset: join(this.persistence.cacheDirectory, `${key}.bin`),
      metadata: join(this.persistence.cacheDirectory, `${key}.json`),
    }
  }

  private async readPersistent(initialUrl: URL): Promise<CachedAsset | null> {
    const paths = this.persistentPaths(initialUrl)
    if (paths === null || this.persistence === null) return null
    try {
      const [metadataStats, assetStats] = await Promise.all([
        stat(paths.metadata),
        stat(paths.asset),
      ])
      if (metadataStats.size > 2_048 || assetStats.size > MAX_ASSET_BYTES) {
        await this.removePersistent(paths)
        return null
      }
      const [rawMetadata, bytes] = await Promise.all([
        readFile(paths.metadata, 'utf8'),
        readFile(paths.asset),
      ])
      const metadata = record(JSON.parse(rawMetadata) as unknown)
      const mimeType = metadata?.['mimeType']
      if (
        metadata?.['url'] !== initialUrl.href ||
        typeof mimeType !== 'string' ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > MAX_ASSET_BYTES
      ) {
        await this.removePersistent(paths)
        return null
      }
      const size = dimensions(bytes, mimeType)
      if (
        size === null ||
        size.width < 1 ||
        size.height < 1 ||
        size.width > MAX_ASSET_DIMENSION ||
        size.height > MAX_ASSET_DIMENSION ||
        size.width * size.height > MAX_ASSET_PIXELS
      ) {
        await this.removePersistent(paths)
        return null
      }
      return { bytes, mimeType }
    } catch {
      return null
    }
  }

  private async writePersistent(initialUrl: URL, asset: CachedAsset): Promise<void> {
    const paths = this.persistentPaths(initialUrl)
    if (paths === null || this.persistence === null) return
    const suffix = `${process.pid}-${randomUUID()}.tmp`
    const temporaryAsset = `${paths.asset}.${suffix}`
    const temporaryMetadata = `${paths.metadata}.${suffix}`
    try {
      await mkdir(this.persistence.cacheDirectory, { recursive: true })
      const metadata: PersistentAssetMetadata = {
        url: initialUrl.href,
        mimeType: asset.mimeType,
      }
      await Promise.all([
        writeFile(temporaryAsset, asset.bytes, { flag: 'wx' }),
        writeFile(temporaryMetadata, JSON.stringify(metadata), {
          encoding: 'utf8',
          flag: 'wx',
        }),
      ])
      await Promise.all([
        rm(paths.asset, { force: true }),
        rm(paths.metadata, { force: true }),
      ])
      await rename(temporaryAsset, paths.asset)
      await rename(temporaryMetadata, paths.metadata)
    } catch {
      // A disk-cache failure must never hide an otherwise valid network image.
    } finally {
      await Promise.all([
        rm(temporaryAsset, { force: true }),
        rm(temporaryMetadata, { force: true }),
      ]).catch(() => undefined)
    }
  }

  private async removePersistent(paths: {
    asset: string
    metadata: string
  }): Promise<void> {
    await Promise.all([
      rm(paths.asset, { force: true }),
      rm(paths.metadata, { force: true }),
    ]).catch(() => undefined)
  }

  private async warmPersistentCache(generation: number): Promise<void> {
    if (this.persistence === null) return
    await mkdir(this.persistence.cacheDirectory, { recursive: true })
    const previous = await this.readManifestState()
    if (
      previous !== null &&
      Date.now() - previous.checkedAt < MANIFEST_CHECK_INTERVAL_MS
    ) {
      return
    }

    const versionBody = await this.fetchJson(
      this.persistence.versionUrl,
      32 * 1024,
      generation,
    )
    if (generation !== this.#generation) return
    const versionData = record(versionBody)
    const version = Number(versionData?.['version'])
    const contentHash = versionData?.['content_hash']
    if (
      previous !== null &&
      Number.isSafeInteger(version) &&
      typeof contentHash === 'string' &&
      contentHash === previous.contentHash
    ) {
      await this.writeManifestState({ ...previous, version, checkedAt: Date.now() })
      return
    }

    const manifestBody = await this.fetchJson(
      this.persistence.manifestUrl,
      MAX_MANIFEST_BYTES,
      generation,
    )
    if (generation !== this.#generation || manifestBody === null) return
    const manifest = record(manifestBody)
    const urls = this.manifestUrls(manifest?.['cards'])
    if (urls.length === 0) return

    let complete = true
    for (let offset = 0; offset < urls.length; offset += BACKGROUND_FETCHES) {
      if (generation !== this.#generation) return
      const results = await Promise.all(
        urls
          .slice(offset, offset + BACKGROUND_FETCHES)
          .map((url) => this.getUrlAsset(url, false)),
      )
      if (results.some((result) => result.kind === 'unavailable')) complete = false
    }
    if (!complete || generation !== this.#generation) return
    await this.prunePersistentCache(urls)
    await this.writeManifestState({
      version: Number.isSafeInteger(Number(manifest?.['version']))
        ? Number(manifest?.['version'])
        : Number.isSafeInteger(version)
          ? version
          : 0,
      contentHash:
        typeof manifest?.['content_hash'] === 'string'
          ? manifest['content_hash'].slice(0, 160)
          : typeof contentHash === 'string'
            ? contentHash.slice(0, 160)
            : '',
      checkedAt: Date.now(),
    })
  }

  private manifestUrls(value: unknown): URL[] {
    const cards = Array.isArray(value)
      ? value.slice(0, MAX_MANIFEST_ASSETS)
      : Object.values(record(value) ?? {}).slice(0, MAX_MANIFEST_ASSETS)
    const urls = new Map<string, URL>()
    for (const rawCard of cards) {
      const card = record(rawCard)
      if (card === null) continue
      for (const key of [
        'icon_url',
        'evolution_icon_url',
        'hero_icon_url',
        'iconUrl',
        'evolutionIconUrl',
        'heroIconUrl',
      ]) {
        const rawUrl = card[key]
        if (typeof rawUrl !== 'string') continue
        const url = allowedUrl(rawUrl)
        if (url !== null) urls.set(url.href, url)
        if (urls.size >= MAX_MANIFEST_ASSETS) return [...urls.values()]
      }
    }
    return [...urls.values()]
  }

  private async prunePersistentCache(urls: readonly URL[]): Promise<void> {
    if (this.persistence === null) return
    const cacheDirectory = this.persistence.cacheDirectory
    const retained = new Set(
      urls.map((url) => createHash('sha256').update(url.href).digest('hex')),
    )
    try {
      const entries = await readdir(cacheDirectory)
      await Promise.all(
        entries.flatMap((entry) => {
          const match = /^([a-f0-9]{64})\.(?:bin|json)$/u.exec(entry)
          return match?.[1] !== undefined && !retained.has(match[1])
            ? [rm(join(cacheDirectory, entry), { force: true })]
            : []
        }),
      )
    } catch {
      // Cleanup is best-effort; validated cache reads remain safe without it.
    }
  }

  private async fetchJson(
    rawUrl: string,
    byteLimit: number,
    generation: number,
  ): Promise<unknown> {
    let url: URL
    try {
      url = new URL(rawUrl)
      if (
        url.protocol !== 'https:' ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        return null
      }
    } catch {
      return null
    }
    const controller = new AbortController()
    this.#controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      if (generation !== this.#generation) return null
      const response = await this.fetchImplementation(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      const bytes = await boundedBytes(response, byteLimit)
      if (bytes === null) return null
      return JSON.parse(bytes.toString('utf8')) as unknown
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      this.#controllers.delete(controller)
    }
  }

  private async readManifestState(): Promise<ManifestState | null> {
    if (this.persistence === null) return null
    try {
      const path = join(this.persistence.cacheDirectory, 'manifest-state.json')
      const fileStats = await stat(path)
      if (fileStats.size > 4_096) return null
      return manifestState(JSON.parse(await readFile(path, 'utf8')) as unknown)
    } catch {
      return null
    }
  }

  private async writeManifestState(state: ManifestState): Promise<void> {
    if (this.persistence === null) return
    const path = join(this.persistence.cacheDirectory, 'manifest-state.json')
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' })
      await rm(path, { force: true })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
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
