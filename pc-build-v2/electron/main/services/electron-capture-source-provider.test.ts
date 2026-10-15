import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeSource {
  id: string
  name: string
  display_id: string
  thumbnail: {
    isEmpty: () => boolean
    getSize: () => { width: number; height: number }
    toJPEG: (quality: number) => Buffer
  }
}

const electron = vi.hoisted(() => {
  const state = {
    displays: [] as {
      id: number
      label: string
      bounds: { x: number; y: number; width: number; height: number }
      scaleFactor: number
    }[],
    origins: new Map<string, { x: number; y: number }>(),
    sources: [] as FakeSource[],
    screenListeners: new Map<string, () => void>(),
    getSources: vi.fn(({ types }: { types: string[]; thumbnailSize?: unknown }) =>
      Promise.resolve(
        state.sources.filter((source) =>
          types.includes(source.id.startsWith('window:') ? 'window' : 'screen'),
        ),
      ),
    ),
  }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: electron.getSources },
  screen: {
    getAllDisplays: () => electron.displays,
    dipToScreenPoint: (point: { x: number; y: number }) =>
      electron.origins.get(`${point.x},${point.y}`) ?? point,
    on: (event: string, listener: () => void) => {
      electron.screenListeners.set(event, listener)
    },
  },
}))
import type {
  WindowMetadataResolver,
  WindowPreviewRecord,
  WindowPreviewResolver,
  WindowsPhysicalDisplay,
  WindowsWindowMetadata,
} from './capture-source-helper'
import { CaptureSourceRegistry, type SourcePreviewImage } from './capture-source-registry'
import { ElectronCaptureSourceProvider } from './electron-capture-source-provider'

const PRIMARY = {
  deviceName: '\\\\.\\DISPLAY1',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
}
const SCALED = {
  deviceName: '\\\\.\\DISPLAY2',
  bounds: { x: -1920, y: -150, width: 1920, height: 1080 },
}

function fakeSource(id: string, name: string): FakeSource {
  return {
    id,
    name,
    display_id: id.startsWith('screen:') ? id.slice(7, -2) : '',
    thumbnail: {
      isEmpty: () => false,
      getSize: () => ({ width: 320, height: 180 }),
      toJPEG: () => Buffer.from(`electron:${id}`),
    },
  }
}

function windows(...handles: string[]): FakeSource[] {
  return handles.map((handle) => fakeSource(`window:${handle}:0`, `Window ${handle}`))
}

function metadataFor(handles: readonly string[]): WindowsWindowMetadata[] {
  return handles.map((handle) => ({
    windowHwnd: handle,
    ownerProcessId: 100 + Number(handle),
    executableLabel: `App${handle}.exe`,
  }))
}

function provider(
  overrides: {
    physicalDisplays?: () => Promise<WindowsPhysicalDisplay[]>
    windowMetadata?: WindowMetadataResolver
    windowPreviews?: WindowPreviewResolver
    logger?: { warn: (message: string, context: unknown) => void }
  } = {},
) {
  return new ElectronCaptureSourceProvider({
    physicalDisplays: overrides.physicalDisplays ?? (() => Promise.resolve([])),
    windowMetadata:
      overrides.windowMetadata ?? ((handles) => Promise.resolve(metadataFor(handles))),
    ...(overrides.windowPreviews === undefined
      ? {}
      : { windowPreviews: overrides.windowPreviews }),
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
  })
}

beforeEach(() => {
  electron.getSources.mockClear()
  electron.displays = [
    {
      id: 10,
      label: 'Primary',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1,
    },
    {
      id: 20,
      label: 'Scaled',
      bounds: { x: -1280, y: -100, width: 1280, height: 720 },
      scaleFactor: 1.5,
    },
  ]
  electron.origins = new Map([
    ['0,0', { x: 0, y: 0 }],
    ['-1280,-100', { x: -1920, y: -150 }],
  ])
  electron.sources = []
  electron.screenListeners = new Map()
})

describe('ElectronCaptureSourceProvider display mapping', () => {
  it('maps every display by unique exact physical bounds without using order', async () => {
    const physicalDisplays = vi.fn().mockResolvedValue([SCALED, PRIMARY])
    await expect(provider({ physicalDisplays }).displays()).resolves.toEqual([
      expect.objectContaining({ id: '10', deviceName: '\\\\.\\DISPLAY1' }),
      expect.objectContaining({ id: '20', deviceName: '\\\\.\\DISPLAY2' }),
    ])
  })

  it('leaves duplicate and mismatched physical bounds unsupported', async () => {
    const physicalDisplays = vi.fn().mockResolvedValue([
      PRIMARY,
      { deviceName: '\\\\.\\DISPLAY9', bounds: PRIMARY.bounds },
      {
        deviceName: '\\\\.\\DISPLAY2',
        bounds: { x: -1920, y: -150, width: 1280, height: 720 },
      },
    ])
    const displays = await provider({ physicalDisplays }).displays()
    expect(displays[0]).not.toHaveProperty('deviceName')
    expect(displays[1]).not.toHaveProperty('deviceName')
  })

  it('keeps display capture unsupported when the helper is unavailable', async () => {
    const logger = { warn: vi.fn() }
    await expect(
      provider({
        physicalDisplays: () => Promise.reject(new Error('unavailable')),
        logger,
      }).displays(),
    ).rejects.toMatchObject({ code: 'SOURCE_METADATA_UNAVAILABLE' })
    expect(logger.warn).toHaveBeenCalledWith(
      'Capture metadata helper unavailable',
      expect.objectContaining({ stage: 'display-metadata', errorClass: 'Error' }),
    )
  })

  it('caches the topology until Electron reports a display change', async () => {
    const physicalDisplays = vi.fn().mockResolvedValue([PRIMARY, SCALED])
    const subject = provider({ physicalDisplays })
    await subject.displays()
    await subject.displays()
    expect(physicalDisplays).toHaveBeenCalledOnce()
    electron.screenListeners.get('display-metrics-changed')?.()
    await subject.displays()
    expect(physicalDisplays).toHaveBeenCalledTimes(2)
  })

  it('reads the topology again when the cached one no longer matches Electron', async () => {
    const physicalDisplays = vi
      .fn()
      .mockResolvedValueOnce([PRIMARY, SCALED])
      .mockResolvedValueOnce([
        PRIMARY,
        { ...SCALED, bounds: { ...SCALED.bounds, x: 1920, y: 0 } },
      ])
    const subject = provider({ physicalDisplays })
    await subject.displays()
    electron.origins.set('-1280,-100', { x: 1920, y: 0 })
    await expect(subject.displays()).resolves.toEqual([
      expect.objectContaining({ deviceName: '\\\\.\\DISPLAY1' }),
      expect.objectContaining({ deviceName: '\\\\.\\DISPLAY2' }),
    ])
    expect(physicalDisplays).toHaveBeenCalledTimes(2)
  })

  it('stops waiting for a slow helper within the budget and reuses its late result', async () => {
    const slow = Promise.withResolvers<WindowsPhysicalDisplay[]>()
    const physicalDisplays = vi.fn(() => slow.promise)
    const subject = provider({ physicalDisplays })
    await expect(subject.displays({ waitMs: 5 })).rejects.toMatchObject({
      code: 'SOURCE_METADATA_UNAVAILABLE',
    })
    slow.resolve([PRIMARY, SCALED])
    await expect(subject.displays({ waitMs: 5 })).resolves.toEqual([
      expect.objectContaining({ deviceName: '\\\\.\\DISPLAY1' }),
      expect.objectContaining({ deviceName: '\\\\.\\DISPLAY2' }),
    ])
    expect(physicalDisplays).toHaveBeenCalledOnce()
  })
})

describe('ElectronCaptureSourceProvider window metadata', () => {
  it.each(['closes', 'process-exits'] as const)(
    'keeps healthy windows usable when an unrelated window %s during lookup',
    async (mode) => {
      electron.sources = [
        fakeSource('window:42:0', 'Transient'),
        fakeSource('window:43:0', 'Game'),
      ]
      const metadata = vi.fn(() => {
        if (mode === 'closes')
          electron.sources = electron.sources.filter(
            (source) => source.id !== 'window:42:0',
          )
        return Promise.resolve([
          { windowHwnd: '43', ownerProcessId: 123, executableLabel: 'Game.exe' },
        ])
      })
      const subject = provider({ windowMetadata: metadata })
      await expect(subject.enumerate()).resolves.toEqual([
        expect.objectContaining({ id: 'window:42:0', metadataAvailable: false }),
        expect.objectContaining({ id: 'window:43:0', metadataAvailable: true }),
      ])
      const registry = new CaptureSourceRegistry(subject)
      const listed = await registry.enumerate()
      expect(
        listed.sources.find((source) => source.label === 'Game')?.captureSupported,
      ).toBe(true)
      if (mode === 'process-exits') {
        const disabled = listed.sources.find((source) => source.label === 'Transient')
        if (disabled === undefined) throw new Error('Missing disabled source')
        expect(disabled.captureSupported).toBe(false)
        await expect(
          registry.resolve(disabled.sourceKey, disabled.revision),
        ).rejects.toMatchObject({ code: 'SOURCE_METADATA_UNAVAILABLE' })
      }
      await expect(
        registry.resolvePreference({
          kind: 'window',
          label: 'Game',
          titleHint: 'Game',
          executableLabel: 'Game.exe',
          windowHwnd: '43',
        }),
      ).resolves.toEqual({ kind: 'window', windowHwnd: '43' })
      await expect(
        registry.resolvePreference({
          kind: 'window',
          label: 'Transient',
          titleHint: 'Transient',
          executableLabel: 'Transient.exe',
          windowHwnd: '42',
        }),
      ).rejects.toMatchObject({
        code: mode === 'closes' ? 'SOURCE_NOT_FOUND' : 'SOURCE_METADATA_UNAVAILABLE',
      })
    },
  )

  it('re-checks a bound window that closes during metadata lookup', async () => {
    electron.sources = [fakeSource('window:42:0', 'Game')]
    const metadata = vi.fn(() => {
      electron.sources = []
      return Promise.resolve([])
    })
    await expect(
      provider({ windowMetadata: metadata }).resolveWindow('42'),
    ).resolves.toBeUndefined()
  })

  it.each(['reject', 'missing', 'executable'])(
    'fails closed with typed unavailable metadata: %s',
    async (mode) => {
      electron.sources = [fakeSource('window:42:0', 'Private title')]
      const metadata = vi.fn()
      if (mode === 'reject')
        metadata.mockRejectedValue(new Error('helper timeout with private output'))
      else
        metadata.mockResolvedValue(
          mode === 'missing'
            ? []
            : [{ windowHwnd: '42', ownerProcessId: 123, executableLabel: null }],
        )
      const subject = provider({ windowMetadata: metadata })
      if (mode === 'reject') {
        await expect(subject.enumerate()).rejects.toMatchObject({
          code: 'SOURCE_METADATA_UNAVAILABLE',
        })
      } else {
        await expect(subject.enumerate()).resolves.toEqual([
          expect.objectContaining({ id: 'window:42:0', metadataAvailable: false }),
        ])
      }
      await expect(subject.resolveWindow('42')).rejects.toMatchObject({
        code: 'SOURCE_METADATA_UNAVAILABLE',
      })
      await expect(subject.resolveWindow('99')).resolves.toBeUndefined()
    },
  )

  it('enriches window sources with batch-resolved process identity', async () => {
    electron.sources = [fakeSource('window:42:0', 'Clash Royale')]
    const metadata = vi
      .fn()
      .mockResolvedValue([
        { windowHwnd: '42', ownerProcessId: 123, executableLabel: 'Emulator.exe' },
      ])
    await expect(provider({ windowMetadata: metadata }).enumerate()).resolves.toEqual([
      {
        id: 'window:42:0',
        name: 'Clash Royale',
        displayId: '',
        metadataAvailable: true,
        ownerProcessId: 123,
        executableLabel: 'Emulator.exe',
      },
    ])
    expect(metadata).toHaveBeenCalledWith(['42'])
  })

  it('caches identity per window and title, and asks only for new or renamed windows', async () => {
    electron.sources = windows('1', '2')
    const metadata = vi.fn<WindowMetadataResolver>((handles) =>
      Promise.resolve(metadataFor(handles)),
    )
    const subject = provider({ windowMetadata: metadata })
    await subject.enumerate()
    await expect(subject.enumerate()).resolves.toEqual([
      expect.objectContaining({ id: 'window:1:0', executableLabel: 'App1.exe' }),
      expect.objectContaining({ id: 'window:2:0', executableLabel: 'App2.exe' }),
    ])
    expect(metadata.mock.calls).toEqual([[['1', '2']]])

    electron.sources = [{ ...fakeSource('window:1:0', 'Renamed') }, ...windows('3')]
    await subject.enumerate()
    expect(metadata.mock.calls.at(-1)).toEqual([['1', '3']])

    // A closed window leaves the cache: a reused handle is asked about again.
    electron.sources = windows('2')
    await subject.enumerate()
    expect(metadata.mock.calls.at(-1)).toEqual([['2']])
  })

  it('lists windows unverified when the helper misses the budget, then caches its late answer', async () => {
    electron.sources = [...windows('1'), fakeSource('screen:10:0', 'Screen')]
    const slow = Promise.withResolvers<WindowsWindowMetadata[]>()
    const metadata = vi.fn<WindowMetadataResolver>(() => slow.promise)
    const logger = { warn: vi.fn() }
    const subject = provider({ windowMetadata: metadata, logger })
    await expect(subject.enumerate({ metadataWaitMs: 5 })).resolves.toEqual([
      { id: 'window:1:0', name: 'Window 1', displayId: '' },
      { id: 'screen:10:0', name: 'Screen', displayId: '10' },
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      'Capture metadata helper unavailable',
      expect.objectContaining({ stage: 'window-metadata-budget' }),
    )
    slow.resolve(metadataFor(['1']))
    await slow.promise
    await expect(subject.enumerate({ metadataWaitMs: 5 })).resolves.toEqual([
      expect.objectContaining({ id: 'window:1:0', executableLabel: 'App1.exe' }),
      expect.objectContaining({ id: 'screen:10:0' }),
    ])
    expect(metadata).toHaveBeenCalledOnce()
  })

  it('lists windows unverified when the helper fails, and they stay selectable', async () => {
    electron.sources = windows('1')
    const metadata = vi.fn<WindowMetadataResolver>(() =>
      Promise.reject(new Error('helper')),
    )
    const subject = provider({ windowMetadata: metadata })
    const registry = new CaptureSourceRegistry(subject)
    const listed = await registry.enumerate()
    expect(listed.sources[0]).toMatchObject({ captureSupported: true, detail: null })
    metadata.mockResolvedValue(metadataFor(['1']))
    await expect(
      registry.resolve(listed.sources[0]?.sourceKey ?? '', listed.revision),
    ).resolves.toMatchObject({
      preference: { executableLabel: 'App1.exe', windowHwnd: '1' },
    })
  })

  it('always asks the helper again when binding a window', async () => {
    electron.sources = windows('1')
    const metadata = vi.fn<WindowMetadataResolver>((handles) =>
      Promise.resolve(metadataFor(handles)),
    )
    const subject = provider({ windowMetadata: metadata })
    await subject.enumerate()
    await subject.resolveWindow('1')
    expect(metadata).toHaveBeenCalledTimes(2)
  })

  it('checks one saved handle with the helper only, never the Electron source list', async () => {
    electron.sources = []
    const listed = electron.getSources.mock.calls.length
    const metadata = vi.fn<WindowMetadataResolver>((handles) =>
      Promise.resolve(handles[0] === '7' ? metadataFor(handles) : []),
    )
    const subject = provider({ windowMetadata: metadata })
    await expect(subject.checkWindow('7')).resolves.toEqual({
      ownerProcessId: expect.any(Number) as number,
      executableLabel: 'App7.exe',
    })
    await expect(subject.checkWindow('8')).resolves.toBeUndefined()
    expect(metadata.mock.calls).toEqual([[['7']], [['8']]])
    expect(electron.getSources.mock.calls.length).toBe(listed)
  })
})

describe('ElectronCaptureSourceProvider previews', () => {
  const size = { width: 360, height: 203 }

  function helperPreview(
    handle: string,
    status: WindowPreviewRecord['status'],
  ): WindowPreviewRecord {
    return status === 'ok'
      ? {
          windowHwnd: handle,
          status,
          title: `Window ${handle}`,
          size: { width: 300, height: 169 },
          jpeg: Buffer.from(`helper:${handle}`),
        }
      : { windowHwnd: handle, status }
  }

  it('streams helper previews and asks Electron only for windows the helper could not draw', async () => {
    electron.sources = [...windows('1', '2', '3'), fakeSource('screen:10:0', 'Screen')]
    const metadata = vi.fn<WindowMetadataResolver>()
    const windowPreviews = vi.fn<WindowPreviewResolver>((_handles, _size, onRecord) => {
      onRecord(helperPreview('1', 'ok'))
      onRecord(helperPreview('2', 'failed'))
      onRecord(helperPreview('3', 'unavailable'))
      return Promise.resolve()
    })
    const images: SourcePreviewImage[] = []
    await provider({ windowMetadata: metadata, windowPreviews }).previews(
      {
        windowSourceIds: ['window:1:0', 'window:2:0', 'window:3:0'],
        screens: true,
        size,
      },
      (image) => images.push(image),
    )
    expect(windowPreviews).toHaveBeenCalledWith(
      ['1', '2', '3'],
      size,
      expect.any(Function),
    )
    expect(metadata).not.toHaveBeenCalled()
    expect(images.map((image) => [image.sourceId, image.jpeg.toString()]).sort()).toEqual(
      [
        ['screen:10:0', 'electron:screen:10:0'],
        ['window:1:0', 'helper:1'],
        ['window:2:0', 'electron:window:2:0'],
      ],
    )
    expect(images.find((image) => image.sourceId === 'window:1:0')).toMatchObject({
      name: 'Window 1',
      size: { width: 300, height: 169 },
    })
  })

  it('keeps previews the helper sent before failing and falls back for the rest', async () => {
    electron.sources = windows('1', '2')
    const logger = { warn: vi.fn() }
    const windowPreviews = vi.fn<WindowPreviewResolver>((_handles, _size, onRecord) => {
      onRecord(helperPreview('1', 'ok'))
      return Promise.reject(new Error('timeout'))
    })
    const images: SourcePreviewImage[] = []
    await provider({ windowPreviews, logger }).previews(
      { windowSourceIds: ['window:1:0', 'window:2:0'], screens: false, size },
      (image) => images.push(image),
    )
    expect(images.map((image) => image.jpeg.toString())).toEqual([
      'helper:1',
      'electron:window:2:0',
    ])
    expect(logger.warn).toHaveBeenCalledWith(
      'Capture metadata helper unavailable',
      expect.objectContaining({ stage: 'window-previews' }),
    )
    expect(electron.getSources).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['window'], thumbnailSize: size }),
    )
  })
})
