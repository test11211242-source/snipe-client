import { randomBytes } from 'node:crypto'
import { basename, win32 } from 'node:path'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  type CapturePreference,
  CaptureSourcePreviewSchema,
  CaptureSourceSnapshotSchema,
  type CaptureSourcePreview,
  type CaptureSourceSnapshot,
  type CaptureSourceView,
} from '../../../shared/models/capture'
import type {
  ResolvedCaptureSource,
  SetupCaptureSelector,
} from '../domain/capture-source'

const PREVIEW_WIDTH = 480
const PREVIEW_HEIGHT = 270
const MAX_PREVIEW_BYTES = 1024 * 1024

export interface CaptureThumbnail {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  toPNG: () => Buffer
}

export interface ElectronCaptureSource {
  id: string
  name: string
  displayId: string
  thumbnail: CaptureThumbnail
  ownerProcessId?: number
  executableLabel?: string
}

export interface ElectronDisplayInfo {
  id: string
  label: string
  bounds: { x: number; y: number; width: number; height: number }
  deviceName?: string
}

export interface CaptureSourceProvider {
  enumerate: (thumbnailSize: {
    width: number
    height: number
  }) => Promise<ElectronCaptureSource[]>
  displays: () => Promise<ElectronDisplayInfo[]>
  ownWindowHandles: () => ReadonlySet<string>
  currentProcessId: number
}

interface RegistryEntry {
  rawId: string
  view: CaptureSourceView
  displayId: string | null
  displayDeviceName: string | null
  windowHwnd: string | null
  executableLabel: string | null
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
  #previewActive = 0
  readonly #previewWaiters: (() => void)[] = []

  constructor(
    private readonly provider: CaptureSourceProvider,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
    private readonly maxPreviewConcurrency = 2,
  ) {}

  async enumerate(): Promise<CaptureSourceSnapshot> {
    const generation = ++this.#enumerationGeneration
    const [sources, displays] = await Promise.all([
      this.provider.enumerate({ width: 0, height: 0 }),
      this.provider.displays(),
    ])
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
          captureSupported: true,
          unavailableReason: null,
        }
        entries.set(sourceKey, {
          rawId: source.id,
          view,
          displayId: null,
          displayDeviceName: null,
          windowHwnd,
          executableLabel,
        })
        continue
      }

      const display = displayById.get(source.displayId)
      if (display === undefined) continue
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
      }
      entries.set(sourceKey, {
        rawId: source.id,
        view,
        displayId: display.id,
        displayDeviceName: display.deviceName ?? null,
        windowHwnd: null,
        executableLabel: null,
      })
    }

    if (generation !== this.#enumerationGeneration) throw this.staleError()
    this.#revision = revision
    this.#expiresAt = this.now() + this.ttlMs
    this.#entries = entries
    return CaptureSourceSnapshotSchema.parse({
      revision,
      expiresAt: this.#expiresAt,
      sources: [...entries.values()].map((entry) => entry.view),
    })
  }

  async getPreview(sourceKey: string, revision: string): Promise<CaptureSourcePreview> {
    const entry = this.getEntry(sourceKey, revision)
    await this.acquirePreviewSlot()
    try {
      const sources = await this.provider.enumerate({
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
      })
      this.assertCurrent(sourceKey, revision)
      const source = sources.find((candidate) => candidate.id === entry.rawId)
      if (source === undefined) throw this.staleError()
      const size = source.thumbnail.getSize()
      if (
        source.thumbnail.isEmpty() ||
        size.width <= 0 ||
        size.height <= 0 ||
        size.width > PREVIEW_WIDTH ||
        size.height > PREVIEW_HEIGHT
      ) {
        throw new ApplicationError('CAPTURE_PREVIEW_INVALID', 'Source preview is invalid')
      }
      const bytes = source.thumbnail.toPNG()
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PREVIEW_BYTES) {
        throw new ApplicationError(
          'CAPTURE_PREVIEW_TOO_LARGE',
          'Source preview is too large',
        )
      }
      return CaptureSourcePreviewSchema.parse({
        sourceKey,
        revision,
        size,
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      })
    } finally {
      this.releasePreviewSlot()
    }
  }

  async resolve(sourceKey: string, revision: string): Promise<ResolvedCaptureSource> {
    const entry = this.getEntry(sourceKey, revision)
    const sources = await this.provider.enumerate({ width: 0, height: 0 })
    this.assertCurrent(sourceKey, revision)
    const currentSource = sources.find((source) => source.id === entry.rawId)
    if (currentSource === undefined) throw this.staleError()

    let selector: SetupCaptureSelector
    if (entry.view.kind === 'window' && entry.windowHwnd !== null) {
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
            }
          : {
              kind: 'display',
              label: entry.view.label,
              displayId: entry.displayId ?? '',
            },
    }
  }

  async resolvePreference(preference: CapturePreference): Promise<SetupCaptureSelector> {
    const [sources, displays] = await Promise.all([
      this.provider.enumerate({ width: 0, height: 0 }),
      this.provider.displays(),
    ])

    if (preference.kind === 'window') {
      const ownHandles = this.provider.ownWindowHandles()
      const matches = sources.filter((source) => {
        const hwnd = parseElectronWindowHandle(source.id)
        if (
          hwnd === null ||
          ownHandles.has(hwnd) ||
          source.ownerProcessId === this.provider.currentProcessId ||
          source.name !== preference.titleHint
        ) {
          return false
        }
        return (
          preference.executableLabel === null ||
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
    if (
      revision !== this.#revision ||
      this.now() > this.#expiresAt ||
      !this.#entries.has(sourceKey)
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

  private async acquirePreviewSlot(): Promise<void> {
    if (this.#previewActive < this.maxPreviewConcurrency) {
      this.#previewActive += 1
      return
    }
    await new Promise<void>((resolve) => this.#previewWaiters.push(resolve))
    this.#previewActive += 1
  }

  private releasePreviewSlot(): void {
    this.#previewActive -= 1
    this.#previewWaiters.shift()?.()
  }
}
