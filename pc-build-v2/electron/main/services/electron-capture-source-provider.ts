import { execFile as nodeExecFile } from 'node:child_process'

import { BrowserWindow, desktopCapturer, screen } from 'electron'

import type {
  CaptureSourceProvider,
  ElectronCaptureSource,
  ElectronDisplayInfo,
} from './capture-source-registry'

const DISPLAY_HELPER_TIMEOUT_MS = 5_000
const DISPLAY_HELPER_MAX_BYTES = 64 * 1024
const DISPLAY_DEVICE_PATTERN = /^\\\\\.\\DISPLAY[1-9]\d*$/
const POWERSHELL_DISPLAY_COMMAND = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CrToolsDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'
if (-not [CrToolsDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { throw 'DPI awareness failed' }
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ deviceName = $_.DeviceName; bounds = [ordered]@{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } } })
ConvertTo-Json -InputObject $screens -Compress -Depth 4`

interface PhysicalBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowsPhysicalDisplay {
  deviceName: string
  bounds: PhysicalBounds
}

export type PhysicalDisplayResolver = () => Promise<WindowsPhysicalDisplay[]>

function validInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function parsePhysicalDisplays(value: string): WindowsPhysicalDisplay[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
    throw new Error('Display helper returned an invalid list')
  }
  return parsed.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid display')
    const record = entry as Record<string, unknown>
    const bounds = record['bounds']
    if (
      Object.keys(record).length !== 2 ||
      typeof record['deviceName'] !== 'string' ||
      !DISPLAY_DEVICE_PATTERN.test(record['deviceName']) ||
      typeof bounds !== 'object' ||
      bounds === null
    ) {
      throw new Error('Display helper returned invalid metadata')
    }
    const rectangle = bounds as Record<string, unknown>
    if (
      Object.keys(rectangle).length !== 4 ||
      !validInteger(rectangle['x']) ||
      !validInteger(rectangle['y']) ||
      !validInteger(rectangle['width']) ||
      !validInteger(rectangle['height']) ||
      rectangle['width'] <= 0 ||
      rectangle['height'] <= 0
    ) {
      throw new Error('Display helper returned invalid bounds')
    }
    return {
      deviceName: record['deviceName'],
      bounds: {
        x: rectangle['x'],
        y: rectangle['y'],
        width: rectangle['width'],
        height: rectangle['height'],
      },
    }
  })
}

export const resolveWindowsPhysicalDisplays: PhysicalDisplayResolver = () =>
  new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Windows display helper is unavailable'))
      return
    }
    nodeExecFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        POWERSHELL_DISPLAY_COMMAND,
      ],
      {
        encoding: 'utf8',
        timeout: DISPLAY_HELPER_TIMEOUT_MS,
        maxBuffer: DISPLAY_HELPER_MAX_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null)
          reject(error instanceof Error ? error : new Error('Display helper failed'))
        else {
          try {
            resolve(parsePhysicalDisplays(stdout))
          } catch (cause) {
            reject(
              cause instanceof Error ? cause : new Error('Display helper output failed'),
            )
          }
        }
      },
    )
  })

function boundsKey(bounds: PhysicalBounds): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
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

export class ElectronCaptureSourceProvider implements CaptureSourceProvider {
  readonly currentProcessId = process.pid

  constructor(
    private readonly physicalDisplays: PhysicalDisplayResolver = resolveWindowsPhysicalDisplays,
  ) {}

  async enumerate(thumbnailSize: { width: number; height: number }) {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize,
      fetchWindowIcons: false,
    })
    return sources.map<ElectronCaptureSource>((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id,
      thumbnail: source.thumbnail,
    }))
  }

  async displays(): Promise<ElectronDisplayInfo[]> {
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
    const windowsDisplays = await this.physicalDisplays().catch(() => [])
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

  ownWindowHandles(): ReadonlySet<string> {
    return new Set(
      BrowserWindow.getAllWindows()
        .map(nativeHandleDecimal)
        .filter((handle): handle is string => handle !== null),
    )
  }
}
