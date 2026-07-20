import { execFile as nodeExecFile } from 'node:child_process'

import { BrowserWindow, desktopCapturer, screen } from 'electron'

import type {
  CaptureSourceProvider,
  ElectronCaptureSource,
  ElectronDisplayInfo,
} from './capture-source-registry'

const DISPLAY_HELPER_TIMEOUT_MS = 5_000
const DISPLAY_HELPER_MAX_BYTES = 64 * 1024
const WINDOW_METADATA_TIMEOUT_MS = 5_000
const WINDOW_METADATA_MAX_BYTES = 256 * 1024
const DISPLAY_DEVICE_PATTERN = /^\\\\\.\\DISPLAY[1-9]\d*$/
const POWERSHELL_DISPLAY_COMMAND = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CrToolsDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }'
if (-not [CrToolsDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) { throw 'DPI awareness failed' }
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ deviceName = $_.DeviceName; bounds = [ordered]@{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } } })
ConvertTo-Json -InputObject $screens -Compress -Depth 4`
const POWERSHELL_WINDOW_METADATA_BODY = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CrToolsWindowMetadata { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }'
$items = @()
foreach ($rawHandle in $Handles.Split(',')) {
  [long]$handle = 0
  if (-not [long]::TryParse($rawHandle, [ref]$handle) -or $handle -le 0) { continue }
  [uint32]$processId = 0
  [void][CrToolsWindowMetadata]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$processId)
  if ($processId -eq 0) { continue }
  try { $executable = "$(Get-Process -Id $processId -ErrorAction Stop | Select-Object -ExpandProperty ProcessName).exe" } catch { $executable = $null }
  if ($null -ne $executable -and $executable.Length -gt 120) { $executable = $executable.Substring(0, 120) }
  $items += [ordered]@{ windowHwnd = $handle.ToString(); ownerProcessId = [int64]$processId; executableLabel = $executable }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 3`

export function buildWindowsWindowMetadataCommand(
  windowHandles: readonly string[],
): string {
  if (
    windowHandles.length === 0 ||
    windowHandles.length > 512 ||
    windowHandles.some((handle) => !/^[1-9]\d{0,18}$/.test(handle))
  ) {
    throw new Error('Window metadata handles are invalid')
  }
  return `$Handles = '${windowHandles.join(',')}'\n${POWERSHELL_WINDOW_METADATA_BODY}`
}

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

export interface WindowsWindowMetadata {
  windowHwnd: string
  ownerProcessId: number
  executableLabel: string | null
}

export type WindowMetadataResolver = (
  windowHandles: readonly string[],
) => Promise<WindowsWindowMetadata[]>

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

export const resolveWindowsWindowMetadata: WindowMetadataResolver = (windowHandles) =>
  new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Windows window metadata helper is unavailable'))
      return
    }
    if (windowHandles.length === 0) {
      resolve([])
      return
    }
    let command: string
    try {
      command = buildWindowsWindowMetadataCommand(windowHandles)
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Window metadata input failed'))
      return
    }
    nodeExecFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      {
        encoding: 'utf8',
        timeout: WINDOW_METADATA_TIMEOUT_MS,
        maxBuffer: WINDOW_METADATA_MAX_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(
            error instanceof Error ? error : new Error('Window metadata helper failed'),
          )
          return
        }
        try {
          const raw: unknown = JSON.parse(stdout)
          const entries = Array.isArray(raw) ? raw : [raw]
          if (entries.length > 512) throw new Error('Window metadata list is too large')
          const parsed: WindowsWindowMetadata[] = []
          for (const entry of entries) {
            if (typeof entry !== 'object' || entry === null) continue
            const record = entry as Record<string, unknown>
            if (
              Object.keys(record).length !== 3 ||
              typeof record['windowHwnd'] !== 'string' ||
              !/^[1-9]\d{0,18}$/.test(record['windowHwnd']) ||
              !validInteger(record['ownerProcessId']) ||
              record['ownerProcessId'] <= 0 ||
              (record['executableLabel'] !== null &&
                (typeof record['executableLabel'] !== 'string' ||
                  record['executableLabel'].length < 1 ||
                  record['executableLabel'].length > 120))
            ) {
              continue
            }
            parsed.push({
              windowHwnd: record['windowHwnd'],
              ownerProcessId: record['ownerProcessId'],
              executableLabel: record['executableLabel'],
            })
          }
          resolve(parsed)
        } catch (cause) {
          reject(
            cause instanceof Error ? cause : new Error('Window metadata output failed'),
          )
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
    private readonly windowMetadata: WindowMetadataResolver = resolveWindowsWindowMetadata,
  ) {}

  async enumerate(thumbnailSize: { width: number; height: number }) {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize,
      fetchWindowIcons: false,
    })
    const handles = sources
      .map((source) => /^window:(\d+):0$/.exec(source.id)?.[1])
      .filter((value): value is string => value !== undefined)
    const metadata = new Map(
      (await this.windowMetadata(handles).catch(() => [])).map((entry) => [
        entry.windowHwnd,
        entry,
      ]),
    )
    return sources.map<ElectronCaptureSource>((source) => {
      const handle = /^window:(\d+):0$/.exec(source.id)?.[1]
      const details = handle === undefined ? undefined : metadata.get(handle)
      return {
        id: source.id,
        name: source.name,
        displayId: source.display_id,
        thumbnail: source.thumbnail,
        ...(details === undefined
          ? {}
          : {
              ownerProcessId: details.ownerProcessId,
              ...(details.executableLabel === null
                ? {}
                : { executableLabel: details.executableLabel }),
            }),
      }
    })
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
