import { randomBytes } from 'node:crypto'
import { basename, win32 } from 'node:path'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  type CapturePreference,
  CaptureSourceSnapshotSchema,
  type CaptureSourceSnapshot,
  type CaptureSourceView,
} from '../../../shared/models/capture'
import type {
  ResolvedCaptureSource,
  SetupCaptureSelector,
} from '../domain/capture-source'

const PREVIEW_WIDTH = 360
const PREVIEW_HEIGHT = 203
const MAX_PREVIEW_BYTES = 512 * 1024
const MAX_TOTAL_PREVIEW_DATA_URL_BYTES = 24 * 1024 * 1024
/** The picker list never waits longer than this for the metadata helpers. */
const LIST_METADATA_WAIT_MS = 1_500

export interface ElectronCaptureSource {
  id: string
  name: string
  displayId: string
  ownerProcessId?: number
  executableLabel?: string
  /**
   * Windows only. `false`: the helper could not identify the window. Absent: not checked yet
   * (helper slow or failed); identity is then verified when the window is selected.
   */
  metadataAvailable?: boolean
}

export interface ElectronDisplayInfo {
  id: string
  label: string
  bounds: { x: number; y: number; width: number; height: number }
  deviceName?: string
}

export interface SourcePreviewRequest {
  windowSourceIds: readonly string[]
  screens: boolean
  size: { width: number; height: number }
}

export interface SourcePreviewImage {
  sourceId: string
  /** Source title when the image was taken; a window whose title changed gets no preview. */
  name: string
  size: { width: number; height: number }
  jpeg: Buffer
}

export interface CaptureSourceProvider {
  /** Without `metadataWaitMs` a metadata failure rejects; with it the list degrades. */
  enumerate: (options?: { metadataWaitMs?: number }) => Promise<ElectronCaptureSource[]>
  /** Delivers previews as they become ready; settles when no more will come. */
  previews?: (
    request: SourcePreviewRequest,
    onPreview: (image: SourcePreviewImage) => void,
  ) => Promise<void>
  resolveWindow?: (windowHwnd: string) => Promise<ElectronCaptureSource | undefined>
  displays: (options?: { waitMs?: number }) => Promise<ElectronDisplayInfo[]>
  ownWindowHandles: () => ReadonlySet<string>
  currentProcessId: number
}

interface PreviewJob {
  revision: string
  /** Count of applied previews; `delivered` is the count the last response carried. */
  version: number
  delivered: number
  done: boolean
  totalBytes: number
  /** Resolves with `done` on every change, then is replaced. */
  wake: PromiseWithResolvers<boolean>
}

interface RegistryEntry {
  rawId: string
  view: CaptureSourceView
  displayId: string | null
  displayDeviceName: string | null
  windowHwnd: string | null
  executableLabel: string | null
  ownerProcessId: number | null
}

function opaqueKey(): string {
  return randomBytes(16).toString('hex')
}

function safeExecutableLabel(value: string | undefined): string | null {
  if (value === undefined) return null
  const label = basename(win32.basename(value)).slice(0, 120)
  return label.length > 0 ? label : null
}

export function parseElectronWindowHandle(sourceId: string): string | null {
  const match = /^window:(\d+):(0|1)$/.exec(sourceId)
  if (match?.[1] === undefined || match[2] !== '0') return null
  try {
    const value = BigInt(match[1])
    return value > 0n && value <= 9_223_372_036_854_775_807n ? value.toString(10) : null
  } catch {
    return null
  }
}

export class CaptureSourceRegistry {
  #revision: string | null = null
  #expiresAt = 0
  #entries = new Map<string, RegistryEntry>()
  #enumerationGeneration = 0
  #previewJob: PreviewJob | null = null

  constructor(
    private readonly provider: CaptureSourceProvider,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
    /** Previews arriving within this window after the first one share one response. */
    private readonly previewBatchMs = 100,
  ) {}

  async enumerate(): Promise<CaptureSourceSnapshot> {
    const generation = ++this.#enumerationGeneration
    const [sources, displayResult] = await Promise.all([
      this.provider.enumerate({ metadataWaitMs: LIST_METADATA_WAIT_MS }),
      this.provider.displays({ waitMs: LIST_METADATA_WAIT_MS }).then(
        (displays) => ({ displays, unavailable: false }),
        () => ({ displays: [], unavailable: true }),
      ),
    ])
    const displays = displayResult.displays
    const displayById = new Map(displays.map((display) => [display.id, display]))
    const ownHandles = this.provider.ownWindowHandles()
    const revision = opaqueKey()
    const entries = new Map<string, RegistryEntry>()

    for (const source of sources.slice(0, 512)) {
      if (entries.size >= 256) break
      const kind = source.id.startsWith('window:') ? 'window' : 'display'
      if (kind === 'window') {
        const windowHwnd = parseElectronWindowHandle(source.id)
        if (
          windowHwnd === null ||
          ownHandles.has(windowHwnd) ||
          source.ownerProcessId === this.provider.currentProcessId
        ) {
          continue
        }
        const sourceKey = opaqueKey()
        const executableLabel = safeExecutableLabel(source.executableLabel)
        const view: CaptureSourceView = {
          sourceKey,
          revision,
          kind,
          label: source.name.slice(0, 300) || 'Untitled window',
          detail: executableLabel,
          captureSupported: source.metadataAvailable !== false,
          unavailableReason:
            source.metadataAvailable === false
              ? 'Не удалось проверить метаданные этого окна.'
              : null,
          preview: null,
        }
        entries.set(sourceKey, {
          rawId: source.id,
          view,
          displayId: null,
          displayDeviceName: null,
          windowHwnd,
          executableLabel,
          ownerProcessId: source.ownerProcessId ?? null,
        })
        continue
      }

      const display = displayById.get(source.displayId)
      if (display === undefined) {
        if (displayResult.unavailable) {
          const sourceKey = opaqueKey()
          entries.set(sourceKey, {
            rawId: source.id,
            view: {
              sourceKey,
              revision,
              kind: 'display',
              label: source.name.slice(0, 300) || 'Экран',
              detail: null,
              captureSupported: false,
              unavailableReason: 'Не удалось проверить метаданные экрана.',
              preview: null,
            },
            displayId: source.displayId,
            displayDeviceName: null,
            windowHwnd: null,
            executableLabel: null,
            ownerProcessId: null,
          })
        }
        continue
      }
      const sourceKey = opaqueKey()
      const mapped = display.deviceName !== undefined && display.deviceName.length > 0
      const label = (display.label || source.name || 'Display').slice(0, 300)
      const view: CaptureSourceView = {
        sourceKey,
        revision,
        kind,
        label,
        detail: `${display.bounds.width} x ${display.bounds.height} at ${display.bounds.x}, ${display.bounds.y}`,
        captureSupported: mapped,
        unavailableReason: mapped
          ? null
          : 'This display cannot be mapped safely to the Windows capture device.',
        preview: null,
      }
      entries.set(sourceKey, {
        rawId: source.id,
        view,
        displayId: display.id,
        displayDeviceName: display.deviceName ?? null,
        windowHwnd: null,
        executableLabel: null,
        ownerProcessId: null,
      })
    }

    if (generation !== this.#enumerationGeneration) throw this.staleError()
    this.#revision = revision
    const replaced = this.#previewJob
    this.#previewJob = null
    replaced?.wake.resolve(replaced.done)
    this.#expiresAt = this.now() + this.ttlMs
    this.#entries = entries
    return CaptureSourceSnapshotSchema.parse({
      revision,
      expiresAt: this.#expiresAt,
      sources: [...entries.values()].map((entry) => entry.view),
    })
  }

  /**
   * Previews arrive progressively: the first call starts loading them, and every call
   * resolves once previews newer than the previous response exist (or loading ends).
   * `previewsPending` tells the caller whether to ask again.
   */
  async loadPreviews(revision: string): Promise<CaptureSourceSnapshot> {
    if (revision !== this.#revision) throw this.staleError()
    let job = this.#previewJob
    if (job?.revision !== revision) {
      job = this.startPreviewJob(revision)
      this.#previewJob = job
    }
    if (!job.done && job.version === job.delivered) {
      const done = await job.wake.promise
      if (!done && this.previewBatchMs > 0 && this.#previewJob === job) {
        const batch = Promise.withResolvers<undefined>()
        setTimeout(() => batch.resolve(undefined), this.previewBatchMs)
        await batch.promise
      }
    }
    if (revision !== this.#revision || this.#previewJob !== job) throw this.staleError()
    job.delivered = job.version
    return CaptureSourceSnapshotSchema.parse({
      revision,
      expiresAt: this.#expiresAt,
      sources: [...this.#entries.values()].map((entry) => entry.view),
      previewsPending: !job.done,
    })
  }

  private startPreviewJob(revision: string): PreviewJob {
    const job: PreviewJob = {
      revision,
      version: 0,
      delivered: 0,
      done: false,
      totalBytes: 0,
      wake: Promise.withResolvers<boolean>(),
    }
    const signal = (): void => {
      const { wake } = job
      job.wake = Promise.withResolvers<boolean>()
      wake.resolve(job.done)
    }
    const entries = [...this.#entries.values()]
    const byRawId = new Map(entries.map((entry) => [entry.rawId, entry]))
    const onPreview = (image: SourcePreviewImage): void => {
      if (this.#previewJob !== job) return
      const entry = byRawId.get(image.sourceId)
      if (
        entry?.view.preview !== null ||
        (entry.view.kind === 'window' && image.name.slice(0, 300) !== entry.view.label)
      )
        return
      const preview = this.preview(image)
      if (
        preview === null ||
        job.totalBytes + preview.dataUrl.length > MAX_TOTAL_PREVIEW_DATA_URL_BYTES
      )
        return
      job.totalBytes += preview.dataUrl.length
      entry.view = { ...entry.view, preview }
      job.version += 1
      signal()
    }
    const request: SourcePreviewRequest = {
      windowSourceIds: entries
        .filter((entry) => entry.view.kind === 'window')
        .map((entry) => entry.rawId),
      screens: entries.some((entry) => entry.view.kind === 'display'),
      size: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
    }
    void (async () => {
      try {
        await this.provider.previews?.(request, onPreview)
      } catch {
        // Previews are optional: the sources stay selectable without them.
      } finally {
        job.done = true
        signal()
      }
    })()
    return job
  }

  async resolve(sourceKey: string, revision: string): Promise<ResolvedCaptureSource> {
    const entry = this.getEntry(sourceKey, revision)
    if (!entry.view.captureSupported && entry.view.kind === 'window') {
      throw new ApplicationError(
        'SOURCE_METADATA_UNAVAILABLE',
        'Window identity metadata is unavailable',
      )
    }
    this.assertExpiredWindowHasIdentity(entry)
    const currentSource =
      entry.windowHwnd !== null && this.provider.resolveWindow !== undefined
        ? await this.provider.resolveWindow(entry.windowHwnd)
        : (await this.provider.enumerate()).find((source) => source.id === entry.rawId)
    this.assertCurrent(sourceKey, revision)
    this.assertExpiredWindowHasIdentity(entry)
    if (currentSource === undefined) throw this.staleError()

    let selector: SetupCaptureSelector
    if (entry.view.kind === 'window' && entry.windowHwnd !== null) {
      if (currentSource.metadataAvailable === false) {
        throw new ApplicationError(
          'SOURCE_METADATA_UNAVAILABLE',
          'Window identity metadata is unavailable',
        )
      }
      if (
        parseElectronWindowHandle(currentSource.id) !== entry.windowHwnd ||
        currentSource.name.slice(0, 300) !== entry.view.label ||
        currentSource.ownerProcessId === this.provider.currentProcessId ||
        (entry.ownerProcessId !== null &&
          currentSource.ownerProcessId !== entry.ownerProcessId) ||
        (entry.executableLabel !== null &&
          safeExecutableLabel(currentSource.executableLabel) !== entry.executableLabel)
      ) {
        throw this.staleError()
      }
      // A window listed unverified (slow metadata helper) takes its identity from this
      // fresh check; `resolveWindow` never returns a window without an executable label.
      entry.executableLabel ??= safeExecutableLabel(currentSource.executableLabel)
      entry.ownerProcessId ??= currentSource.ownerProcessId ?? null
      selector = { kind: 'window', windowHwnd: entry.windowHwnd }
    } else if (
      entry.view.kind === 'display' &&
      entry.displayId !== null &&
      entry.displayDeviceName !== null
    ) {
      const currentDisplay = (await this.provider.displays()).find(
        (display) => display.id === currentSource.displayId,
      )
      if (
        currentSource.displayId !== entry.displayId ||
        currentDisplay?.deviceName !== entry.displayDeviceName
      ) {
        throw this.staleError()
      }
      selector = {
        kind: 'display',
        electronDisplayId: entry.displayId,
        displayDeviceName: entry.displayDeviceName,
      }
    } else {
      throw new ApplicationError(
        'DISPLAY_MAPPING_UNSUPPORTED',
        'The selected display cannot be mapped safely to a Windows capture device',
      )
    }

    return {
      view: entry.view,
      selector,
      preference:
        entry.view.kind === 'window'
          ? {
              kind: 'window',
              label: entry.view.label,
              titleHint: entry.view.label,
              executableLabel: entry.executableLabel,
              ...(entry.windowHwnd === null ? {} : { windowHwnd: entry.windowHwnd }),
            }
          : {
              kind: 'display',
              label: entry.view.label,
              displayId: entry.displayId ?? '',
            },
    }
  }

  async resolvePreference(preference: CapturePreference): Promise<SetupCaptureSelector> {
    if (preference.kind === 'window' && preference.executableLabel === null)
      throw new ApplicationError(
        'SOURCE_REBIND_REQUIRED',
        'Choose the window again to save its executable identity',
      )
    const [sources, displays] = await Promise.all([
      this.provider.enumerate(),
      preference.kind === 'display' ? this.provider.displays() : Promise.resolve([]),
    ])
    return this.matchPreference(
      preference,
      sources,
      displays,
      this.provider.ownWindowHandles(),
      true,
    )
  }

  async resolvePreferences(
    preferences: readonly CapturePreference[],
  ): Promise<readonly (SetupCaptureSelector | ApplicationError)[]> {
    if (preferences.length === 0) return []
    const [enumeration, displayList] = await Promise.allSettled([
      this.provider.enumerate(),
      preferences.some((preference) => preference.kind === 'display')
        ? this.provider.displays()
        : Promise.resolve([]),
    ])
    const sources = enumeration.status === 'fulfilled' ? enumeration.value : []
    const displays = displayList.status === 'fulfilled' ? displayList.value : []
    const enumerationError =
      enumeration.status === 'rejected' ? this.metadataError(enumeration.reason) : null
    const displayError =
      displayList.status === 'rejected' ? this.metadataError(displayList.reason) : null
    const ownHandles = this.provider.ownWindowHandles()
    return Promise.all(
      preferences.map(async (preference) => {
        if (preference.kind === 'window' && preference.executableLabel === null)
          return new ApplicationError(
            'SOURCE_REBIND_REQUIRED',
            'Choose the window again to save its executable identity',
          )
        if (enumerationError !== null) return enumerationError
        if (preference.kind === 'display' && displayError !== null) return displayError
        try {
          // Profile health uses this one snapshot, without spawning per-window metadata probes.
          return await this.matchPreference(
            preference,
            sources,
            displays,
            ownHandles,
            false,
          )
        } catch (error) {
          return this.metadataError(error)
        }
      }),
    )
  }

  private metadataError(error: unknown): ApplicationError {
    return error instanceof ApplicationError
      ? error
      : new ApplicationError(
          'SOURCE_METADATA_UNAVAILABLE',
          'Source identity is unavailable',
        )
  }

  private async matchPreference(
    preference: CapturePreference,
    sources: readonly ElectronCaptureSource[],
    displays: readonly ElectronDisplayInfo[],
    ownHandles: ReadonlySet<string>,
    recheckUnverifiableWindow: boolean,
  ): Promise<SetupCaptureSelector> {
    if (preference.kind === 'window') {
      const unverifiable = sources.find(
        (source) =>
          source.metadataAvailable === false &&
          !ownHandles.has(parseElectronWindowHandle(source.id) ?? '') &&
          source.ownerProcessId !== this.provider.currentProcessId &&
          (preference.windowHwnd !== undefined
            ? parseElectronWindowHandle(source.id) === preference.windowHwnd
            : source.name === preference.titleHint),
      )
      if (unverifiable !== undefined) {
        const hwnd = parseElectronWindowHandle(unverifiable.id)
        if (
          recheckUnverifiableWindow &&
          hwnd !== null &&
          this.provider.resolveWindow !== undefined
        ) {
          const current = await this.provider.resolveWindow(hwnd)
          if (current === undefined)
            throw new ApplicationError('SOURCE_NOT_FOUND', 'The configured window closed')
        }
        throw new ApplicationError(
          'SOURCE_METADATA_UNAVAILABLE',
          'Configured window identity metadata is unavailable',
        )
      }
      if (preference.windowHwnd !== undefined) {
        const bound = sources.filter((source) => {
          const hwnd = parseElectronWindowHandle(source.id)
          return (
            hwnd === preference.windowHwnd &&
            !ownHandles.has(hwnd) &&
            source.ownerProcessId !== this.provider.currentProcessId &&
            source.metadataAvailable !== false &&
            preference.executableLabel !== null &&
            safeExecutableLabel(source.executableLabel) === preference.executableLabel
          )
        })
        if (bound.length === 1) {
          return { kind: 'window', windowHwnd: preference.windowHwnd }
        }
      }
      const matches = sources.filter((source) => {
        const hwnd = parseElectronWindowHandle(source.id)
        if (
          hwnd === null ||
          ownHandles.has(hwnd) ||
          source.ownerProcessId === this.provider.currentProcessId ||
          source.metadataAvailable === false ||
          source.name !== preference.titleHint
        ) {
          return false
        }
        return (
          preference.executableLabel !== null &&
          safeExecutableLabel(source.executableLabel) === preference.executableLabel
        )
      })
      if (matches.length === 0) {
        throw new ApplicationError(
          'SOURCE_NOT_FOUND',
          'The configured window is not open with the exact saved title',
        )
      }
      if (matches.length !== 1) {
        throw new ApplicationError(
          'SOURCE_AMBIGUOUS',
          'Multiple windows match the saved title; close duplicates or configure again',
        )
      }
      const hwnd = parseElectronWindowHandle(matches[0]?.id ?? '')
      if (hwnd === null) {
        throw new ApplicationError(
          'SOURCE_NOT_FOUND',
          'The configured window is unavailable',
        )
      }
      return { kind: 'window', windowHwnd: hwnd }
    }

    const display = displays.filter((candidate) => candidate.id === preference.displayId)
    const sourcesForDisplay = sources.filter(
      (source) =>
        !source.id.startsWith('window:') && source.displayId === preference.displayId,
    )
    if (display.length === 0 || sourcesForDisplay.length === 0) {
      throw new ApplicationError(
        'SOURCE_NOT_FOUND',
        'The configured display is no longer available; configure capture again',
      )
    }
    if (display.length !== 1 || sourcesForDisplay.length !== 1) {
      throw new ApplicationError(
        'SOURCE_AMBIGUOUS',
        'The configured display cannot be resolved uniquely',
      )
    }
    const current = display[0]
    if (current?.deviceName === undefined || current.deviceName.length === 0) {
      throw new ApplicationError(
        'SOURCE_NOT_FOUND',
        'The configured display cannot be mapped safely to Windows capture',
      )
    }
    return {
      kind: 'display',
      electronDisplayId: preference.displayId,
      displayDeviceName: current.deviceName,
    }
  }

  private getEntry(sourceKey: string, revision: string): RegistryEntry {
    this.assertCurrent(sourceKey, revision)
    const entry = this.#entries.get(sourceKey)
    if (entry === undefined) throw this.staleError()
    return entry
  }

  private assertCurrent(sourceKey: string, revision: string): void {
    if (revision !== this.#revision || !this.#entries.has(sourceKey)) {
      throw this.staleError()
    }
  }

  private assertExpiredWindowHasIdentity(entry: RegistryEntry): void {
    if (
      this.now() > this.#expiresAt &&
      entry.view.kind === 'window' &&
      entry.ownerProcessId === null
    ) {
      throw this.staleError()
    }
  }

  private staleError(): ApplicationError {
    return new ApplicationError(
      'CAPTURE_SOURCE_STALE',
      'Capture sources changed or expired; refresh the list',
    )
  }

  private preview(image: SourcePreviewImage): CaptureSourceView['preview'] {
    const { width, height } = image.size
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > PREVIEW_WIDTH ||
      height > PREVIEW_HEIGHT ||
      image.jpeg.byteLength === 0 ||
      image.jpeg.byteLength > MAX_PREVIEW_BYTES
    )
      return null
    return {
      size: { width, height },
      dataUrl: `data:image/jpeg;base64,${image.jpeg.toString('base64')}`,
    }
  }
}
