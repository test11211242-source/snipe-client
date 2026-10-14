import { spawn as nodeSpawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

/**
 * Source-picker metadata and window previews from `python/capture_sources.py`: plain ctypes
 * calls in one short-lived process per request (no PowerShell, no compiled helper), JSON
 * lines on stdout. Every record is validated here before main uses it.
 */

const HANDLE_PATTERN = /^[1-9]\d{0,18}$/
const DISPLAY_DEVICE_PATTERN = /^\\\\\.\\DISPLAY[1-9]\d*$/
const MAX_HANDLES = 512
const MAX_LINE_CHARS = 1024 * 1024
const MAX_TOTAL_CHARS = 64 * 1024 * 1024
const MAX_PREVIEW_BYTES = 512 * 1024
const DISPLAY_TIMEOUT_MS = 3_000
const WINDOW_METADATA_TIMEOUT_MS = 3_000
const PREVIEW_BASE_TIMEOUT_MS = 5_000
const PREVIEW_PER_WINDOW_TIMEOUT_MS = 60
const PREVIEW_MAX_TIMEOUT_MS = 20_000

export interface PhysicalBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowsPhysicalDisplay {
  deviceName: string
  bounds: PhysicalBounds
}

export interface WindowsWindowMetadata {
  windowHwnd: string
  ownerProcessId: number
  executableLabel: string | null
}

export type WindowPreviewRecord =
  | {
      windowHwnd: string
      status: 'ok'
      title: string
      size: { width: number; height: number }
      jpeg: Buffer
    }
  | { windowHwnd: string; status: 'unavailable' | 'failed' }

export type PhysicalDisplayResolver = () => Promise<WindowsPhysicalDisplay[]>
export type WindowMetadataResolver = (
  windowHandles: readonly string[],
) => Promise<WindowsWindowMetadata[]>
/** Streams one record per handle, in request order, as each window is captured. */
export type WindowPreviewResolver = (
  windowHandles: readonly string[],
  maxSize: { width: number; height: number },
  onRecord: (record: WindowPreviewRecord) => void,
) => Promise<void>

export interface CaptureSourceHelpers {
  physicalDisplays: PhysicalDisplayResolver
  windowMetadata: WindowMetadataResolver
  windowPreviews: WindowPreviewResolver
}

export class CaptureSourceHelperError extends Error {
  override readonly name = 'CaptureSourceHelperError'

  constructor(
    readonly reason: 'start' | 'timeout' | 'exit' | 'output',
    message: string,
  ) {
    super(message)
  }
}

export interface HelperChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  kill: () => boolean
}

export type HelperSpawn = (executable: string, args: readonly string[]) => HelperChild

const defaultSpawn: HelperSpawn = (executable, args) =>
  nodeSpawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  })

function validInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CaptureSourceHelperError('output', 'Helper record is not an object')
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => key in value)
}

function validHandles(handles: readonly string[]): void {
  if (
    handles.length === 0 ||
    handles.length > MAX_HANDLES ||
    handles.some((handle) => !HANDLE_PATTERN.test(handle))
  )
    throw new CaptureSourceHelperError('output', 'Window handles are invalid')
}

export function parsePhysicalDisplays(value: unknown): WindowsPhysicalDisplay[] {
  const outer = record(value)
  const list = outer['displays']
  if (
    !onlyKeys(outer, ['displays']) ||
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > 64
  )
    throw new CaptureSourceHelperError(
      'output',
      'Display helper returned an invalid list',
    )
  return list.map((entry: unknown) => {
    const display = record(entry)
    const deviceName = display['deviceName']
    const bounds = display['bounds']
    if (
      !onlyKeys(display, ['deviceName', 'bounds']) ||
      typeof deviceName !== 'string' ||
      !DISPLAY_DEVICE_PATTERN.test(deviceName)
    )
      throw new CaptureSourceHelperError(
        'output',
        'Display helper returned invalid metadata',
      )
    const rectangle = record(bounds)
    const { x, y, width, height } = rectangle
    if (
      !onlyKeys(rectangle, ['x', 'y', 'width', 'height']) ||
      !validInteger(x) ||
      !validInteger(y) ||
      !validInteger(width) ||
      !validInteger(height) ||
      width <= 0 ||
      height <= 0
    )
      throw new CaptureSourceHelperError(
        'output',
        'Display helper returned invalid bounds',
      )
    return { deviceName, bounds: { x, y, width, height } }
  })
}

/** Malformed individual entries are skipped: their windows stay unverifiable. */
export function parseWindowMetadata(
  value: unknown,
  requested: ReadonlySet<string>,
): WindowsWindowMetadata[] {
  const outer = record(value)
  const list = outer['windows']
  if (!onlyKeys(outer, ['windows']) || !Array.isArray(list) || list.length > MAX_HANDLES)
    throw new CaptureSourceHelperError('output', 'Window metadata list is invalid')
  const parsed: WindowsWindowMetadata[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const { windowHwnd, ownerProcessId, executableLabel } = item
    if (
      !onlyKeys(item, ['windowHwnd', 'ownerProcessId', 'executableLabel']) ||
      typeof windowHwnd !== 'string' ||
      !requested.has(windowHwnd) ||
      !validInteger(ownerProcessId) ||
      ownerProcessId <= 0 ||
      (executableLabel !== null &&
        (typeof executableLabel !== 'string' ||
          executableLabel.length < 1 ||
          executableLabel.length > 120))
    )
      continue
    parsed.push({ windowHwnd, ownerProcessId, executableLabel })
  }
  return parsed
}

export function parseWindowPreview(
  value: unknown,
  requested: ReadonlySet<string>,
  maxSize: { width: number; height: number },
): WindowPreviewRecord {
  const item = record(value)
  const { windowHwnd, status } = item
  if (typeof windowHwnd !== 'string' || !requested.has(windowHwnd))
    throw new CaptureSourceHelperError('output', 'Preview record has an unknown window')
  if (status === 'unavailable' || status === 'failed') {
    if (!onlyKeys(item, ['windowHwnd', 'status']))
      throw new CaptureSourceHelperError('output', 'Preview record is invalid')
    return { windowHwnd, status }
  }
  const { title, width, height, jpeg } = item
  if (
    status !== 'ok' ||
    !onlyKeys(item, ['windowHwnd', 'status', 'title', 'width', 'height', 'jpeg']) ||
    typeof title !== 'string' ||
    title.length > 300 ||
    !validInteger(width) ||
    !validInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > maxSize.width ||
    height > maxSize.height ||
    typeof jpeg !== 'string' ||
    jpeg.length > Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(jpeg)
  )
    throw new CaptureSourceHelperError('output', 'Preview record is invalid')
  const bytes = Buffer.from(jpeg, 'base64')
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    throw new CaptureSourceHelperError('output', 'Preview is not a JPEG image')
  return { windowHwnd, status, title, size: { width, height }, jpeg: bytes }
}

/**
 * Runs one helper request. Records reach `onRecord` as soon as each line arrives; the
 * process is killed on timeout or on the first invalid line.
 */
export function runCaptureSourceHelper(
  options: { executable: string; scriptPath: string; spawn?: HelperSpawn },
  request: unknown,
  timeoutMs: number,
  onRecord: (value: unknown) => void,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>()
  let child: HelperChild
  try {
    child = (options.spawn ?? defaultSpawn)(options.executable, [
      '-B',
      options.scriptPath,
    ])
  } catch {
    reject(new CaptureSourceHelperError('start', 'Capture source helper failed to start'))
    return promise
  }
  let settled = false
  let pending = ''
  let total = 0
  const settle = (error?: CaptureSourceHelperError): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    child.stdout.removeAllListeners('data')
    if (error === undefined) resolve(undefined)
    else {
      child.kill()
      reject(error)
    }
  }
  const timer = setTimeout(
    () =>
      settle(new CaptureSourceHelperError('timeout', 'Capture source helper timed out')),
    timeoutMs,
  )
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    total += chunk.length
    if (total > MAX_TOTAL_CHARS) {
      settle(
        new CaptureSourceHelperError(
          'output',
          'Capture source helper output is too large',
        ),
      )
      return
    }
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline >= 0 && !settled) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      try {
        onRecord(JSON.parse(line))
      } catch (cause) {
        settle(
          cause instanceof CaptureSourceHelperError
            ? cause
            : new CaptureSourceHelperError(
                'output',
                'Capture source helper output is invalid',
              ),
        )
        return
      }
      newline = pending.indexOf('\n')
    }
    if (pending.length > MAX_LINE_CHARS)
      settle(
        new CaptureSourceHelperError('output', 'Capture source helper line is too long'),
      )
  })
  child.once('error', () =>
    settle(
      new CaptureSourceHelperError('start', 'Capture source helper failed to start'),
    ),
  )
  child.once('close', (code: number | null) => {
    if (code === 0 && pending.length === 0) settle()
    else settle(new CaptureSourceHelperError('exit', 'Capture source helper failed'))
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(JSON.stringify(request))
  return promise
}

export function createCaptureSourceHelpers(options: {
  executable: string
  scriptPath: string
  /** Runtime integrity gate shared with every other Python process. */
  beforeSpawn?: () => Promise<void>
  spawn?: HelperSpawn
}): CaptureSourceHelpers {
  const run = async (
    request: unknown,
    timeoutMs: number,
    onRecord: (value: unknown) => void,
  ): Promise<void> => {
    if (process.platform !== 'win32' && options.spawn === undefined)
      throw new CaptureSourceHelperError('start', 'Capture source helper needs Windows')
    await options.beforeSpawn?.()
    await runCaptureSourceHelper(options, request, timeoutMs, onRecord)
  }
  const single = async <T>(
    request: unknown,
    timeoutMs: number,
    parse: (value: unknown) => T,
  ): Promise<T> => {
    const results: T[] = []
    await run(request, timeoutMs, (value) => {
      if (results.length > 0)
        throw new CaptureSourceHelperError('output', 'Unexpected helper record')
      results.push(parse(value))
    })
    const [result] = results
    if (result === undefined)
      throw new CaptureSourceHelperError(
        'output',
        'Capture source helper returned nothing',
      )
    return result
  }
  return {
    physicalDisplays: () =>
      single({ op: 'displays' }, DISPLAY_TIMEOUT_MS, parsePhysicalDisplays),
    windowMetadata: async (windowHandles) => {
      if (windowHandles.length === 0) return []
      validHandles(windowHandles)
      const requested = new Set(windowHandles)
      return single(
        { op: 'windows', handles: [...windowHandles] },
        WINDOW_METADATA_TIMEOUT_MS,
        (value) => parseWindowMetadata(value, requested),
      )
    },
    windowPreviews: async (windowHandles, maxSize, onRecord) => {
      if (windowHandles.length === 0) return
      validHandles(windowHandles)
      const requested = new Set(windowHandles)
      await run(
        {
          op: 'previews',
          handles: [...windowHandles],
          maxWidth: maxSize.width,
          maxHeight: maxSize.height,
        },
        Math.min(
          PREVIEW_MAX_TIMEOUT_MS,
          PREVIEW_BASE_TIMEOUT_MS + PREVIEW_PER_WINDOW_TIMEOUT_MS * windowHandles.length,
        ),
        (value) => {
          const preview = parseWindowPreview(value, requested, maxSize)
          requested.delete(preview.windowHwnd)
          onRecord(preview)
        },
      )
    },
  }
}
