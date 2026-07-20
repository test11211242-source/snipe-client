import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  displays: [] as {
    id: number
    label: string
    bounds: { x: number; y: number; width: number; height: number }
    scaleFactor: number
  }[],
  origins: new Map<string, { x: number; y: number }>(),
  sources: [] as {
    id: string
    name: string
    display_id: string
    thumbnail: { isEmpty: () => boolean }
  }[],
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: vi.fn(() => Promise.resolve(electron.sources)) },
  screen: {
    getAllDisplays: () => electron.displays,
    dipToScreenPoint: (point: { x: number; y: number }) =>
      electron.origins.get(`${point.x},${point.y}`) ?? point,
  },
}))

import {
  buildWindowsWindowMetadataCommand,
  ElectronCaptureSourceProvider,
  type WindowsPhysicalDisplay,
} from './electron-capture-source-provider'

beforeEach(() => {
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
})

function resolver(displays: WindowsPhysicalDisplay[]) {
  return vi.fn().mockResolvedValue(displays)
}

describe('ElectronCaptureSourceProvider display mapping', () => {
  it('maps every display by unique exact physical bounds without using order', async () => {
    const provider = new ElectronCaptureSourceProvider(
      resolver([
        {
          deviceName: '\\\\.\\DISPLAY2',
          bounds: { x: -1920, y: -150, width: 1920, height: 1080 },
        },
        {
          deviceName: '\\\\.\\DISPLAY1',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
      ]),
    )

    await expect(provider.displays()).resolves.toEqual([
      expect.objectContaining({ id: '10', deviceName: '\\\\.\\DISPLAY1' }),
      expect.objectContaining({ id: '20', deviceName: '\\\\.\\DISPLAY2' }),
    ])
  })

  it('leaves duplicate and mismatched physical bounds unsupported', async () => {
    const provider = new ElectronCaptureSourceProvider(
      resolver([
        {
          deviceName: '\\\\.\\DISPLAY1',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
        {
          deviceName: '\\\\.\\DISPLAY9',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
        {
          deviceName: '\\\\.\\DISPLAY2',
          bounds: { x: -1920, y: -150, width: 1280, height: 720 },
        },
      ]),
    )

    const displays = await provider.displays()
    expect(displays[0]).not.toHaveProperty('deviceName')
    expect(displays[1]).not.toHaveProperty('deviceName')
  })

  it('keeps display capture unsupported when the helper is unavailable', async () => {
    const provider = new ElectronCaptureSourceProvider(() =>
      Promise.reject(new Error('unavailable')),
    )
    const displays = await provider.displays()
    expect(displays).toHaveLength(2)
    expect(displays[0]).not.toHaveProperty('deviceName')
    expect(displays[1]).not.toHaveProperty('deviceName')
  })
})

describe('ElectronCaptureSourceProvider window metadata', () => {
  it('embeds validated handles in the PowerShell command instead of using trailing switches', () => {
    const command = buildWindowsWindowMetadataCommand(['42', '9007199254740993'])
    expect(command).toContain("$Handles = '42,9007199254740993'")
    expect(command).not.toContain('param(')
    expect(() => buildWindowsWindowMetadataCommand(["42'; exit"])).toThrow(
      'Window metadata handles are invalid',
    )
  })

  it('enriches window sources with batch-resolved process identity', async () => {
    electron.sources = [
      {
        id: 'window:42:0',
        name: 'Clash Royale',
        display_id: '',
        thumbnail: { isEmpty: () => false },
      },
    ]
    const metadata = vi
      .fn()
      .mockResolvedValue([
        { windowHwnd: '42', ownerProcessId: 123, executableLabel: 'Emulator.exe' },
      ])
    const provider = new ElectronCaptureSourceProvider(resolver([]), metadata)

    await expect(provider.enumerate({ width: 0, height: 0 })).resolves.toEqual([
      expect.objectContaining({
        id: 'window:42:0',
        ownerProcessId: 123,
        executableLabel: 'Emulator.exe',
      }),
    ])
    expect(metadata).toHaveBeenCalledWith(['42'])
  })
})
