import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { ApplicationError } from '../../../shared/errors/application-error'

import type {
  PhysicalBounds,
  PhysicalDisplayResolver,
  WindowMetadataResolver,
  WindowPreviewResolver,
  WindowsPhysicalDisplay,
  WindowsWindowMetadata,
} from './capture-source-helper'
import type {
  CaptureSourceProvider,
  ElectronCaptureSource,
  ElectronDisplayInfo,
  SourcePreviewImage,
  SourcePreviewRequest,
} from './capture-source-registry'

const PREVIEW_JPEG_QUALITY = 76

export interface ElectronCaptureSourceProviderDependencies {
  physicalDisplays: PhysicalDisplayResolver
  windowMetadata: WindowMetadataResolver
  windowPreviews?: WindowPreviewResolver
  logger?: { warn: (message: string, context: unknown) => void }
}

interface CachedWindowMetadata {
  title: string
  ownerProcessId: number
  executableLabel: string
}

function boundsKey(bounds: PhysicalBounds): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
}

function windowHandle(sourceId: string): string | undefined {
  return /^window:(\d+):0$/.exec(sourceId)?.[1]
}

function nativeHandleDecimal(window: BrowserWindow): string | null {
  const bytes = window.getNativeWindowHandle()
  if (bytes.byteLength === 0) return null
  let value = 0n
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0)
  }
  return value > 0n && value <= 9_223_372_036_854_775_807n ? value.toString(10) : null
}

/** Resolves with the value, or with `null` once `waitMs` passes first. */
async function withinBudget<T>(promise: Promise<T>, waitMs: number): Promise<T | null> {
  const expired = Promise.withResolvers<null>()
  const timer = setTimeout(() => expired.resolve(null), waitMs)
  try {
    return await Promise.race([promise, expired.promise])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Electron enumerates capturable sources; `capture_sources.py` adds window process identity,
 * Windows display device names and window previews. Window identity is cached per HWND and
 * title, display topology until Electron reports a display change. A slow or failed helper
 * never fails the picker list: windows it could not check are listed unverified and are
 * verified again on selection.
 */
export class ElectronCaptureSourceProvider implements CaptureSourceProvider {
  readonly currentProcessId = process.pid
  readonly #windowMetadata = new Map<string, CachedWindowMetadata>()
  #physicalDisplays: WindowsPhysicalDisplay[] | null = null
  #physicalDisplayLoad: Promise<WindowsPhysicalDisplay[]> | null = null
  #topologyGeneration = 0
  #watchingDisplays = false

  constructor(private readonly dependencies: ElectronCaptureSourceProviderDependencies) {}

  async enumerate(options: { metadataWaitMs?: number } = {}) {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    })
    const titles = new Map<string, string>()
    for (const source of sources) {
      const handle = windowHandle(source.id)
      if (handle !== undefined) titles.set(handle, source.name)
    }
    const { known, complete } = await this.windowMetadataFor(
      titles,
      options.metadataWaitMs,
    )
    return sources.map<ElectronCaptureSource>((source) => {
      const base = { id: source.id, name: source.name, displayId: source.display_id }
      const handle = windowHandle(source.id)
      if (handle === undefined) return base
      const details = known.get(handle)
      if (details === undefined)
        return complete ? { ...base, metadataAvailable: false } : base
      return {
        ...base,
        metadataAvailable: details.executableLabel !== null,
        ownerProcessId: details.ownerProcessId,
        ...(details.executableLabel === null
          ? {}
          : { executableLabel: details.executableLabel }),
      }
    })
  }

  /**
   * `complete: false` means the helper did not answer (failure or `waitMs` budget): windows
   * missing from `known` are unverified rather than unidentifiable.
   */
  private async windowMetadataFor(
    titles: ReadonlyMap<string, string>,
    waitMs: number | undefined,
  ): Promise<{ known: Map<string, WindowsWindowMetadata>; complete: boolean }> {
    for (const handle of this.#windowMetadata.keys())
      if (!titles.has(handle)) this.#windowMetadata.delete(handle)
    const known = new Map<string, WindowsWindowMetadata>()
    const missing: string[] = []
    for (const [handle, title] of titles) {
      const cached = this.#windowMetadata.get(handle)
      if (cached?.title === title)
        known.set(handle, {
          windowHwnd: handle,
          ownerProcessId: cached.ownerProcessId,
          executableLabel: cached.executableLabel,
        })
      else missing.push(handle)
    }
    if (missing.length === 0) return { known, complete: true }

    const startedAt = Date.now()
    const lookup = this.dependencies.windowMetadata(missing).then((entries) => {
      for (const entry of entries) {
        const title = titles.get(entry.windowHwnd)
        if (title !== undefined && entry.executableLabel !== null)
          this.#windowMetadata.set(entry.windowHwnd, {
            title,
            ownerProcessId: entry.ownerProcessId,
            executableLabel: entry.executableLabel,
          })
      }
      return entries
    })
    if (waitMs === undefined) {
      const entries = await lookup.catch((cause: unknown) => {
        this.logUnavailable('window-metadata', startedAt, cause)
        throw new ApplicationError(
          'SOURCE_METADATA_UNAVAILABLE',
          'Window metadata is unavailable',
          { cause },
        )
      })
      for (const entry of entries) known.set(entry.windowHwnd, entry)
      return { known, complete: true }
    }
    const outcome = await withinBudget(
      lookup.catch((cause: unknown) => {
        this.logUnavailable('window-metadata', startedAt, cause)
        return 'failed' as const
      }),
      waitMs,
    )
    if (outcome === null) {
      // The helper keeps running and fills the cache for the next list.
      this.logUnavailable('window-metadata-budget', startedAt, null)
      return { known, complete: false }
    }
    if (outcome === 'failed') return { known, complete: false }
    for (const entry of outcome) known.set(entry.windowHwnd, entry)
    return { known, complete: true }
  }

  /** Always asks the helper again: binding a window never trusts cached identity. */
  async resolveWindow(windowHwnd: string): Promise<ElectronCaptureSource | undefined> {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    })
    const source = sources.find((candidate) => candidate.id === `window:${windowHwnd}:0`)
    if (source === undefined) return undefined
    const startedAt = Date.now()
    const details = (
      await this.dependencies.windowMetadata([windowHwnd]).catch((cause: unknown) => {
        this.logUnavailable('bound-window-metadata', startedAt, cause)
        throw new ApplicationError(
          'SOURCE_METADATA_UNAVAILABLE',
          'Window metadata is unavailable',
          { cause },
        )
      })
    ).find((entry) => entry.windowHwnd === windowHwnd)
    if (details?.executableLabel == null) {
      this.#windowMetadata.delete(windowHwnd)
      const current = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      })
      if (!current.some((candidate) => candidate.id === source.id)) return undefined
      throw new ApplicationError(
        'SOURCE_METADATA_UNAVAILABLE',
        'Window identity metadata is unavailable',
      )
    }
    this.#windowMetadata.set(windowHwnd, {
      title: source.name,
      ownerProcessId: details.ownerProcessId,
      executableLabel: details.executableLabel,
    })
    return {
      id: source.id,
      name: source.name,
      displayId: source.display_id,
      ownerProcessId: details.ownerProcessId,
      executableLabel: details.executableLabel,
    }
  }

  /** One helper call for one handle (owner process + executable); no Electron source list. */
  async checkWindow(
    windowHwnd: string,
  ): Promise<{ ownerProcessId: number; executableLabel: string | null } | undefined> {
    const startedAt = Date.now()
    const details = (
      await this.dependencies.windowMetadata([windowHwnd]).catch((cause: unknown) => {
        this.logUnavailable('saved-window-check', startedAt, cause)
        throw cause
      })
    ).find((entry) => entry.windowHwnd === windowHwnd)
    return details === undefined
      ? undefined
      : {
          ownerProcessId: details.ownerProcessId,
          executableLabel: details.executableLabel,
        }
  }

  /**
   * Window previews stream from the helper one by one; windows it could not draw (and every
   * window when the helper fails) fall back to one Electron thumbnail batch. Screens use
   * Electron thumbnails in parallel. Never rejects.
   */
  async previews(
    request: SourcePreviewRequest,
    onPreview: (image: SourcePreviewImage) => void,
  ): Promise<void> {
    await Promise.allSettled([
      request.screens
        ? this.electronPreviews('screen', request.size, null, onPreview)
        : Promise.resolve(),
      this.windowPreviews(request.windowSourceIds, request.size, onPreview),
    ])
  }

  private async windowPreviews(
    sourceIds: readonly string[],
    size: { width: number; height: number },
    onPreview: (image: SourcePreviewImage) => void,
  ): Promise<void> {
    const pending = new Map<string, string>()
    for (const sourceId of sourceIds) {
      const handle = windowHandle(sourceId)
      if (handle !== undefined) pending.set(handle, sourceId)
    }
    if (pending.size === 0) return
    if (this.dependencies.windowPreviews !== undefined) {
      const startedAt = Date.now()
      try {
        await this.dependencies.windowPreviews([...pending.keys()], size, (record) => {
          const sourceId = pending.get(record.windowHwnd)
          if (sourceId === undefined || record.status === 'failed') return
          pending.delete(record.windowHwnd)
          if (record.status === 'ok')
            onPreview({
              sourceId,
              name: record.title,
              size: record.size,
              jpeg: record.jpeg,
            })
        })
      } catch (cause) {
        this.logUnavailable('window-previews', startedAt, cause)
      }
    }
    if (pending.size > 0)
      await this.electronPreviews('window', size, new Set(pending.values()), onPreview)
  }

  private async electronPreviews(
    type: 'window' | 'screen',
    size: { width: number; height: number },
    only: ReadonlySet<string> | null,
    onPreview: (image: SourcePreviewImage) => void,
  ): Promise<void> {
    const sources = await desktopCapturer.getSources({
      types: [type],
      thumbnailSize: size,
      fetchWindowIcons: false,
    })
    for (const source of sources) {
      if ((only !== null && !only.has(source.id)) || source.thumbnail.isEmpty()) continue
      onPreview({
        sourceId: source.id,
        name: source.name,
        size: source.thumbnail.getSize(),
        jpeg: source.thumbnail.toJPEG(PREVIEW_JPEG_QUALITY),
      })
    }
  }

  async displays(options: { waitMs?: number } = {}): Promise<ElectronDisplayInfo[]> {
    this.watchDisplayChanges()
    const electronDisplays = screen.getAllDisplays().map((display) => {
      const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
      return {
        display,
        physicalBounds: {
          x: origin.x,
          y: origin.y,
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor),
        },
      }
    })
    const cached = this.#physicalDisplays
    let mapped = this.mapDisplays(
      electronDisplays,
      cached ?? (await this.loadPhysicalDisplays(options.waitMs)),
    )
    if (cached !== null && mapped.some((display) => display.deviceName === undefined)) {
      // The cached topology disagrees with Electron's current one: read it again.
      this.#physicalDisplays = null
      mapped = this.mapDisplays(
        electronDisplays,
        await this.loadPhysicalDisplays(options.waitMs),
      )
    }
    return mapped
  }

  private watchDisplayChanges(): void {
    if (this.#watchingDisplays) return
    this.#watchingDisplays = true
    const invalidate = (): void => {
      this.#topologyGeneration += 1
      this.#physicalDisplays = null
    }
    screen.on('display-added', invalidate)
    screen.on('display-removed', invalidate)
    screen.on('display-metrics-changed', invalidate)
  }

  /** One helper run at a time; with `waitMs`, a slow run keeps going and fills the cache. */
  private async loadPhysicalDisplays(waitMs: number | undefined) {
    if (this.#physicalDisplayLoad === null) {
      const generation = this.#topologyGeneration
      const startedAt = Date.now()
      const load = this.dependencies.physicalDisplays().then(
        (displays) => {
          if (generation === this.#topologyGeneration) this.#physicalDisplays = displays
          return displays
        },
        (cause: unknown) => {
          this.logUnavailable('display-metadata', startedAt, cause)
          throw new ApplicationError(
            'SOURCE_METADATA_UNAVAILABLE',
            'Display metadata is unavailable',
            { cause },
          )
        },
      )
      this.#physicalDisplayLoad = load
      void load
        .finally(() => {
          if (this.#physicalDisplayLoad === load) this.#physicalDisplayLoad = null
        })
        .catch(() => undefined)
    }
    const load = this.#physicalDisplayLoad
    if (waitMs === undefined) return load
    const displays = await withinBudget(load, waitMs)
    if (displays === null)
      throw new ApplicationError(
        'SOURCE_METADATA_UNAVAILABLE',
        'Display metadata is not ready yet',
      )
    return displays
  }

  private mapDisplays(
    electronDisplays: readonly {
      display: Electron.Display
      physicalBounds: PhysicalBounds
    }[],
    windowsDisplays: readonly WindowsPhysicalDisplay[],
  ): ElectronDisplayInfo[] {
    const electronCounts = new Map<string, number>()
    const windowsByBounds = new Map<string, WindowsPhysicalDisplay[]>()
    const windowsDeviceCounts = new Map<string, number>()
    for (const candidate of electronDisplays) {
      const key = boundsKey(candidate.physicalBounds)
      electronCounts.set(key, (electronCounts.get(key) ?? 0) + 1)
    }
    for (const candidate of windowsDisplays) {
      const key = boundsKey(candidate.bounds)
      const matches = windowsByBounds.get(key) ?? []
      matches.push(candidate)
      windowsByBounds.set(key, matches)
      windowsDeviceCounts.set(
        candidate.deviceName,
        (windowsDeviceCounts.get(candidate.deviceName) ?? 0) + 1,
      )
    }
    return electronDisplays.map(({ display, physicalBounds }) => {
      const key = boundsKey(physicalBounds)
      const matches = windowsByBounds.get(key) ?? []
      const deviceName =
        electronCounts.get(key) === 1 &&
        matches.length === 1 &&
        windowsDeviceCounts.get(matches[0]?.deviceName ?? '') === 1
          ? matches[0]?.deviceName
          : undefined
      return {
        id: String(display.id),
        label: display.label,
        bounds: display.bounds,
        ...(deviceName === undefined ? {} : { deviceName }),
      }
    })
  }

  private logUnavailable(stage: string, startedAt: number, cause: unknown): void {
    this.dependencies.logger?.warn('Capture metadata helper unavailable', {
      stage,
      durationMs: Date.now() - startedAt,
      errorClass: cause instanceof Error ? cause.name : 'Unknown',
      ...(cause instanceof Error && 'reason' in cause && typeof cause.reason === 'string'
        ? { reason: cause.reason }
        : {}),
    })
  }

  ownWindowHandles(): ReadonlySet<string> {
    return new Set(
      BrowserWindow.getAllWindows()
        .map(nativeHandleDecimal)
        .filter((handle): handle is string => handle !== null),
    )
  }
}
