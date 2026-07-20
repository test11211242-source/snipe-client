import { describe, expect, it } from 'vitest'

import type {
  CaptureSourceProvider,
  ElectronCaptureSource,
  ElectronDisplayInfo,
} from './capture-source-registry'
import {
  CaptureSourceRegistry,
  parseElectronWindowHandle,
} from './capture-source-registry'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test value')
  return value
}

function thumbnail(bytes = Buffer.from('png')) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 320, height: 180 }),
    toPNG: () => bytes,
    toJPEG: () => bytes,
  }
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
    thumbnail: thumbnail(),
    ...(ownerProcessId === undefined ? {} : { ownerProcessId }),
  }
}

describe('CaptureSourceRegistry', () => {
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
    const enumerateSizes: { width: number; height: number }[] = []
    const provider: CaptureSourceProvider = {
      currentProcessId: 1,
      enumerate: (size) => {
        enumerateSizes.push(size)
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
    expect(item.preview).toMatchObject({
      size: { width: 320, height: 180 },
      dataUrl: 'data:image/jpeg;base64,cG5n',
    })
    expect(enumerateSizes).toEqual([{ width: 360, height: 203 }])
    await expect(registry.resolve(item.sourceKey, '0'.repeat(32))).rejects.toMatchObject({
      code: 'CAPTURE_SOURCE_STALE',
    })
    now = 111
    await expect(
      registry.resolve(item.sourceKey, snapshot.revision),
    ).resolves.toMatchObject({
      selector: { kind: 'window', windowHwnd: '12' },
    })
    expect(enumerateSizes).toEqual([
      { width: 360, height: 203 },
      { width: 0, height: 0 },
    ])
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
      enumerate: () =>
        Promise.resolve([
          {
            ...source('window:12:0', 'Game'),
            thumbnail: thumbnail(Buffer.alloc(512 * 1024 + 1)),
          },
        ]),
      ownWindowHandles: () => new Set(),
      displays: () => Promise.resolve([]),
    }
    const snapshot = await new CaptureSourceRegistry(provider).enumerate()
    expect(snapshot.sources[0]).toMatchObject({
      captureSupported: true,
      preview: null,
    })
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
