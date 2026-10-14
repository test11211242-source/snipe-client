import { describe, expect, it, vi } from 'vitest'
import { ApplicationError } from '../../../shared/errors/application-error'

import type {
  CaptureSourceProvider,
  ElectronCaptureSource,
  ElectronDisplayInfo,
  SourcePreviewImage,
} from './capture-source-registry'
import {
  CaptureSourceRegistry,
  parseElectronWindowHandle,
} from './capture-source-registry'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test value')
  return value
}

function image(
  sourceId: string,
  name: string,
  jpeg = Buffer.from('jpg'),
): SourcePreviewImage {
  return { sourceId, name, size: { width: 320, height: 180 }, jpeg }
}

function source(
  id: string,
  name: string,
  displayId = '',
  ownerProcessId?: number,
): ElectronCaptureSource {
  return {
    id,
    name,
    displayId,
    ...(ownerProcessId === undefined ? {} : { ownerProcessId }),
  }
}

describe('CaptureSourceRegistry', () => {
  it('preserves metadata-unavailable distinctly from an absent source without selecting fallback', async () => {
    const enumerate = vi
      .fn()
      .mockRejectedValue(
        new ApplicationError('SOURCE_METADATA_UNAVAILABLE', 'Metadata unavailable'),
      )
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate,
      displays: vi.fn().mockResolvedValue([]),
      ownWindowHandles: () => new Set(),
    }
    const registry = new CaptureSourceRegistry(provider)
    const preference = {
      kind: 'window' as const,
      label: 'Game',
      titleHint: 'Game',
      executableLabel: 'Game.exe',
      windowHwnd: '12',
    }
    await expect(registry.resolvePreference(preference)).rejects.toMatchObject({
      code: 'SOURCE_METADATA_UNAVAILABLE',
    })
    enumerate.mockResolvedValueOnce([])
    await expect(registry.resolvePreference(preference)).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    })
  })

  it('returns selectable sources before previews and streams previews progressively without changing keys', async () => {
    const sources = [
      source('window:12:0', 'Game', '', 20),
      source('window:13:0', 'Chat', '', 20),
    ]
    let deliver!: (image: SourcePreviewImage) => void
    const finished = Promise.withResolvers<undefined>()
    const previews = vi.fn<NonNullable<CaptureSourceProvider['previews']>>(
      (_request, onPreview) => {
        deliver = onPreview
        return finished.promise
      },
    )
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: vi.fn().mockResolvedValue(sources),
      previews,
      ownWindowHandles: () => new Set(),
      displays: vi.fn().mockResolvedValue([]),
    }
    const registry = new CaptureSourceRegistry(provider, 30_000, Date.now, 0)
    const listed = await registry.enumerate()
    expect(previews).not.toHaveBeenCalled()
    expect(listed.sources[0]?.preview).toBeNull()
    const first = registry.loadPreviews(listed.revision)
    expect(previews).toHaveBeenCalledOnce()
    expect(previews.mock.calls[0]?.[0]).toEqual({
      windowSourceIds: ['window:12:0', 'window:13:0'],
      screens: false,
      size: { width: 360, height: 203 },
    })
    await expect(
      registry.resolve(required(listed.sources[0]).sourceKey, listed.revision),
    ).resolves.toMatchObject({ selector: { kind: 'window', windowHwnd: '12' } })
    deliver(image('window:12:0', 'Game'))
    const partial = await first
    expect(partial.previewsPending).toBe(true)
    expect(partial.sources[0]?.sourceKey).toBe(listed.sources[0]?.sourceKey)
    expect(partial.sources[0]?.preview?.dataUrl).toBe('data:image/jpeg;base64,anBn')
    expect(partial.sources[1]?.preview).toBeNull()

    const second = registry.loadPreviews(listed.revision)
    deliver(image('window:13:0', 'Renamed chat'))
    deliver(image('window:13:0', 'Chat'))
    finished.resolve(undefined)
    const completed = await second
    expect(completed.sources[1]?.preview).not.toBeNull()
    await expect(registry.loadPreviews(listed.revision)).resolves.toMatchObject({
      previewsPending: false,
    })
    expect(previews).toHaveBeenCalledOnce()
  })

  it('drops a window preview taken under another title and ends when previews fail', async () => {
    const registry = new CaptureSourceRegistry(
      {
        currentProcessId: 1,
        enumerate: () => Promise.resolve([source('window:12:0', 'Game')]),
        previews: (_request, onPreview) => {
          onPreview(image('window:12:0', 'Other title'))
          return Promise.reject(new Error('helper failed'))
        },
        ownWindowHandles: () => new Set(),
        displays: () => Promise.resolve([]),
      },
      30_000,
      Date.now,
      0,
    )
    const listed = await registry.enumerate()
    await expect(registry.loadPreviews(listed.revision)).resolves.toMatchObject({
      previewsPending: false,
      sources: [{ preview: null, captureSupported: true }],
    })
  })

  it('rejects a waiting preview request for a replaced source list', async () => {
    let deliver!: (image: SourcePreviewImage) => void
    const registry = new CaptureSourceRegistry({
      currentProcessId: 1,
      enumerate: () => Promise.resolve([source('window:12:0', 'Game')]),
      previews: (_request, onPreview) => {
        deliver = onPreview
        return new Promise(() => undefined)
      },
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    })
    const first = await registry.enumerate()
    const previews = registry.loadPreviews(first.revision)
    const rejected = expect(previews).rejects.toMatchObject({
      code: 'CAPTURE_SOURCE_STALE',
    })
    const second = await registry.enumerate()
    await rejected
    deliver(image('window:12:0', 'Game'))
    expect(second.sources[0]?.preview).toBeNull()
  })

  it('lists a window the metadata helper could not check and verifies it on selection', async () => {
    const enumerate = vi.fn().mockResolvedValue([source('window:12:0', 'Game')])
    const resolveWindow = vi.fn().mockResolvedValue({
      ...source('window:12:0', 'Game', '', 20),
      executableLabel: 'Game.exe',
    })
    const registry = new CaptureSourceRegistry({
      currentProcessId: 1,
      enumerate,
      resolveWindow,
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    })
    const listed = await registry.enumerate()
    expect(enumerate).toHaveBeenCalledWith({ metadataWaitMs: 1_500 })
    const item = required(listed.sources[0])
    expect(item).toMatchObject({ captureSupported: true, detail: null })
    await expect(
      registry.resolve(item.sourceKey, listed.revision),
    ).resolves.toMatchObject({
      selector: { kind: 'window', windowHwnd: '12' },
      preference: { executableLabel: 'Game.exe', windowHwnd: '12' },
    })
    expect(resolveWindow).toHaveBeenCalledWith('12')

    resolveWindow.mockResolvedValue({
      ...source('window:12:0', 'Game', '', 1),
      executableLabel: 'CR Tools.exe',
    })
    const relisted = await registry.enumerate()
    const own = required(relisted.sources[0])
    await expect(
      registry.resolve(own.sourceKey, relisted.revision),
    ).rejects.toMatchObject({
      code: 'CAPTURE_SOURCE_STALE',
    })
  })
  it('does not run the display helper when resolving a saved window', async () => {
    const displays = vi.fn().mockRejectedValue(new Error('slow helper unavailable'))
    const registry = new CaptureSourceRegistry({
      currentProcessId: 1,
      enumerate: () =>
        Promise.resolve([
          { ...source('window:12:0', 'Game'), executableLabel: 'Game.exe' },
        ]),
      ownWindowHandles: () => new Set(),
      displays,
    })
    await expect(
      registry.resolvePreference({
        kind: 'window',
        label: 'Game',
        titleHint: 'Game',
        executableLabel: 'Game.exe',
      }),
    ).resolves.toMatchObject({ windowHwnd: '12' })
    expect(displays).not.toHaveBeenCalled()
  })
  it('joins shuffled displays by display_id and handles negative bounds and text-only titles', async () => {
    const sources = [
      source('screen:1:0', 'Wrong order', '22'),
      source('window:9007199254740993:0', '<img src=x onerror=alert(1)>'),
      source('window:15:0', '<img src=x onerror=alert(1)>'),
      source('screen:0:0', 'Other', '11'),
      source('window:99:0', 'Own'),
      source('window:100:0', 'Own process', '', 1234),
    ]
    const provider: CaptureSourceProvider = {
      currentProcessId: 1234,
      enumerate: () => Promise.resolve(sources),
      ownWindowHandles: () => new Set(['99']),
      displays: () =>
        Promise.resolve([
          { id: '11', label: 'Right', bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
          {
            id: '22',
            label: 'Left',
            deviceName: '\\\\.\\DISPLAY2',
            bounds: { x: -2560, y: -200, width: 2560, height: 1440 },
          },
        ]),
    }
    const registry = new CaptureSourceRegistry(provider)
    const result = await registry.enumerate()
    expect(result.sources).toHaveLength(4)
    expect(result.sources.filter((item) => item.label.includes('<img'))).toHaveLength(2)
    const left = result.sources.find((item) => item.label === 'Left')
    expect(left).toMatchObject({
      captureSupported: true,
      detail: '2560 x 1440 at -2560, -200',
    })
    const right = result.sources.find((item) => item.label === 'Right')
    expect(right).toMatchObject({ captureSupported: false })
    if (right === undefined) throw new Error('Missing right display')
    await expect(
      registry.resolve(right.sourceKey, result.revision),
    ).rejects.toMatchObject({
      code: 'DISPLAY_MAPPING_UNSUPPORTED',
    })
    const largeHandle = required(
      result.sources.find((item) => item.label.includes('<img')),
    )
    const resolved = await registry.resolve(largeHandle.sourceKey, result.revision)
    expect(resolved.selector).toEqual({ kind: 'window', windowHwnd: '9007199254740993' })
    expect(resolved.preference).toMatchObject({ windowHwnd: '9007199254740993' })
  })

  it('keeps an expired snapshot usable after live identity validation', async () => {
    let now = 100
    const enumerateOptions: unknown[] = []
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: (options) => {
        enumerateOptions.push(options)
        return Promise.resolve([
          {
            ...source('window:12:0', 'Game', '', 20),
          },
        ])
      },
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    }
    const registry = new CaptureSourceRegistry(provider, 10, () => now)
    const snapshot = await registry.enumerate()
    const item = required(snapshot.sources[0])
    expect(item.preview).toBeNull()
    expect(enumerateOptions).toEqual([{ metadataWaitMs: 1_500 }])
    await expect(registry.resolve(item.sourceKey, '0'.repeat(32))).rejects.toMatchObject({
      code: 'CAPTURE_SOURCE_STALE',
    })
    now = 111
    await expect(
      registry.resolve(item.sourceKey, snapshot.revision),
    ).resolves.toMatchObject({
      selector: { kind: 'window', windowHwnd: '12' },
    })
    expect(enumerateOptions).toEqual([{ metadataWaitMs: 1_500 }, undefined])
  })

  it('rejects an expired window snapshot when HWND ownership changes', async () => {
    let now = 100
    let ownerProcessId = 20
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: () =>
        Promise.resolve([source('window:12:0', 'Game', '', ownerProcessId)]),
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    }
    const registry = new CaptureSourceRegistry(provider, 10, () => now)
    const snapshot = await registry.enumerate()
    const item = required(snapshot.sources[0])
    now = 111
    ownerProcessId = 21

    await expect(
      registry.resolve(item.sourceKey, snapshot.revision),
    ).rejects.toMatchObject({
      code: 'CAPTURE_SOURCE_STALE',
    })
  })

  it('rejects a PID-less snapshot when live enumeration crosses its expiry', async () => {
    let now = 100
    let enumerations = 0
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: () => {
        enumerations += 1
        if (enumerations === 2) now = 111
        return Promise.resolve([source('window:12:0', 'Game')])
      },
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    }
    const registry = new CaptureSourceRegistry(provider, 10, () => now)
    const snapshot = await registry.enumerate()
    const item = required(snapshot.sources[0])
    now = 110

    await expect(
      registry.resolve(item.sourceKey, snapshot.revision),
    ).rejects.toMatchObject({ code: 'CAPTURE_SOURCE_STALE' })
  })

  it('keeps a source usable when its preview is oversized', async () => {
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: () => Promise.resolve([source('window:12:0', 'Game')]),
      previews: (_request, onPreview) => {
        onPreview(image('window:12:0', 'Game', Buffer.alloc(512 * 1024 + 1)))
        return Promise.resolve()
      },
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    }
    const registry = new CaptureSourceRegistry(provider)
    const listed = await registry.enumerate()
    const snapshot = await registry.loadPreviews(listed.revision)
    expect(snapshot.sources[0]).toMatchObject({
      captureSupported: true,
      preview: null,
    })
    expect(snapshot.previewsPending).toBe(false)
  })

  it('parses HWND candidates without JavaScript number conversion', () => {
    expect(parseElectronWindowHandle('window:9007199254740993:0')).toBe(
      '9007199254740993',
    )
    expect(parseElectronWindowHandle('window:1e3:0')).toBeNull()
    expect(parseElectronWindowHandle('window:12:1')).toBeNull()
    expect(parseElectronWindowHandle('window:12:0:extra')).toBeNull()
    expect(parseElectronWindowHandle('window:9223372036854775807:0')).toBe(
      '9223372036854775807',
    )
    expect(parseElectronWindowHandle('window:9223372036854775808:0')).toBeNull()
    expect(parseElectronWindowHandle('screen:1:0')).toBeNull()
  })

  it('re-resolves windows by exact durable title and executable label', async () => {
    let sources = [
      { ...source('window:12:0', 'Clash Royale'), executableLabel: 'Game.exe' },
    ]
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: () => Promise.resolve(sources),
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    }
    const registry = new CaptureSourceRegistry(provider)
    const preference = {
      kind: 'window' as const,
      label: 'Clash Royale',
      titleHint: 'Clash Royale',
      executableLabel: 'Game.exe',
    }
    await expect(registry.resolvePreference(preference)).resolves.toEqual({
      kind: 'window',
      windowHwnd: '12',
    })
    sources = [
      { ...source('window:12:0', 'Clash Royale - Battle'), executableLabel: 'Game.exe' },
    ]
    await expect(registry.resolvePreference(preference)).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    })
    sources = [
      { ...source('window:12:0', 'Clash Royale'), executableLabel: 'Game.exe' },
      { ...source('window:13:0', 'Clash Royale'), executableLabel: 'Game.exe' },
    ]
    await expect(registry.resolvePreference(preference)).rejects.toMatchObject({
      code: 'SOURCE_AMBIGUOUS',
    })
  })

  it('prefers a validated persisted HWND when duplicate emulator windows are open', async () => {
    const sources = [
      { ...source('window:12:0', 'Clash Royale'), executableLabel: 'Game.exe' },
      { ...source('window:13:0', 'Clash Royale'), executableLabel: 'Game.exe' },
    ]
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: () => Promise.resolve(sources),
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    }
    const registry = new CaptureSourceRegistry(provider)
    await expect(
      registry.resolvePreference({
        kind: 'window',
        label: 'Second instance',
        titleHint: 'Clash Royale',
        executableLabel: 'Game.exe',
        windowHwnd: '13',
      }),
    ).resolves.toEqual({ kind: 'window', windowHwnd: '13' })
  })

  it('fails closed for stale or unmapped durable displays', async () => {
    let displays: ElectronDisplayInfo[] = [
      {
        id: '22',
        label: 'Display',
        deviceName: '\\\\.\\DISPLAY2',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: () => Promise.resolve([source('screen:1:0', 'Display', '22')]),
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve(displays),
    }
    const registry = new CaptureSourceRegistry(provider)
    await expect(
      registry.resolvePreference({ kind: 'display', label: 'Display', displayId: '22' }),
    ).resolves.toEqual({
      kind: 'display',
      electronDisplayId: '22',
      displayDeviceName: '\\\\.\\DISPLAY2',
    })
    displays = [
      { id: '22', label: 'Display', bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]
    await expect(
      registry.resolvePreference({ kind: 'display', label: 'Display', displayId: '22' }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
  })
})

describe('M1 source picker degraded metadata', () => {
  it('keeps windows selectable when the display helper fails and marks displays unavailable', async () => {
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: vi
        .fn()
        .mockResolvedValue([
          source('window:12:0', 'Game', '', 20),
          source('screen:99:0', 'Screen', '99'),
        ]),
      displays: vi.fn().mockRejectedValue(new Error('display metadata unavailable')),
      ownWindowHandles: () => new Set(),
    }
    const registry = new CaptureSourceRegistry(provider)
    const listed = await registry.enumerate()
    expect(listed.sources).toHaveLength(2)
    const window = required(listed.sources.find((entry) => entry.kind === 'window'))
    const display = required(listed.sources.find((entry) => entry.kind === 'display'))
    expect(window.captureSupported).toBe(true)
    expect(display.captureSupported).toBe(false)
    expect(display.unavailableReason).toMatch(/метаданные/)
    await expect(
      registry.resolve(window.sourceKey, listed.revision),
    ).resolves.toMatchObject({
      selector: { kind: 'window', windowHwnd: '12' },
    })
  })

  it('does not recover an absent saved HWND by title alone when executable identity is unknown', async () => {
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: vi.fn().mockResolvedValue([source('window:13:0', 'Game', '', 20)]),
      displays: vi.fn().mockResolvedValue([]),
      ownWindowHandles: () => new Set(),
    }
    await expect(
      new CaptureSourceRegistry(provider).resolvePreference({
        kind: 'window',
        label: 'Game',
        titleHint: 'Game',
        executableLabel: null,
        windowHwnd: '12',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_REBIND_REQUIRED' })
  })
})

describe('review regression saved window identity', () => {
  it('#3 requires rebind instead of waiting for a binding without executable identity', async () => {
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      ownWindowHandles: () => new Set(),
      enumerate: vi
        .fn()
        .mockResolvedValue([
          { ...source('window:12:0', 'Game', '', 20), executableLabel: 'Game.exe' },
        ]),
      displays: vi.fn().mockResolvedValue([]),
    }
    const registry = new CaptureSourceRegistry(provider)
    await expect(
      registry.resolvePreference({
        kind: 'window',
        label: 'Game',
        titleHint: 'Game',
        windowHwnd: '12',
        executableLabel: null,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_REBIND_REQUIRED' })
  })
})

describe('review regression native source enumeration budget', () => {
  it('#8 matches every profile against one enumeration without per-window metadata probes', async () => {
    const enumerate = vi.fn().mockResolvedValue([
      { ...source('window:12:0', 'Game A', '', 20), executableLabel: 'Game.exe' },
      {
        ...source('window:13:0', 'Game B', '', 21),
        executableLabel: 'Game.exe',
        metadataAvailable: false,
      },
    ])
    const resolveWindow = vi.fn()
    const registry = new CaptureSourceRegistry({
      currentProcessId: 1,
      enumerate,
      displays: vi.fn().mockResolvedValue([]),
      ownWindowHandles: () => new Set(),
      resolveWindow,
    })
    const first = {
      kind: 'window' as const,
      label: 'Game A',
      titleHint: 'Game A',
      executableLabel: 'Game.exe',
      windowHwnd: '12',
    }
    const outcomes = await registry.resolvePreferences([
      first,
      { ...first, titleHint: 'Game B', windowHwnd: '13' },
      { ...first, executableLabel: null },
    ])
    expect(outcomes).toMatchObject([
      { kind: 'window', windowHwnd: '12' },
      { code: 'SOURCE_METADATA_UNAVAILABLE' },
      { code: 'SOURCE_REBIND_REQUIRED' },
    ])
    expect(enumerate).toHaveBeenCalledOnce()
    expect(resolveWindow).not.toHaveBeenCalled()
  })
})

describe('review regression batched source failure isolation', () => {
  it('#8 retains verifiable window health when only display metadata fails', async () => {
    const enumerate = vi
      .fn()
      .mockResolvedValue([
        { ...source('window:12:0', 'Game', '', 20), executableLabel: 'Game.exe' },
        source('screen:0:0', 'Display', '1'),
      ])
    const registry = new CaptureSourceRegistry({
      currentProcessId: 1,
      enumerate,
      ownWindowHandles: () => new Set(),
      displays: vi.fn().mockRejectedValue(new Error('Display helper failed')),
    })
    const health = await registry.resolvePreferences([
      {
        kind: 'window',
        label: 'Game',
        titleHint: 'Game',
        executableLabel: 'Game.exe',
        windowHwnd: '12',
      },
      { kind: 'display', label: 'Display', displayId: '1' },
    ])
    expect(health).toMatchObject([
      { kind: 'window', windowHwnd: '12' },
      { code: 'SOURCE_METADATA_UNAVAILABLE' },
    ])
    expect(enumerate).toHaveBeenCalledOnce()
  })
})
