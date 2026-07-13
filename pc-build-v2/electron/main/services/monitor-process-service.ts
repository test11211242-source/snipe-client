import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  MonitorProcessEventSchema,
  MonitorStartCommandSchema,
  MonitorStopCommandSchema,
  type MonitorProcessEvent,
  type MonitorStartPayload,
} from '../../../shared/contracts/monitor-protocol'

const READY_TIMEOUT_MS = 8_000
const STOP_TIMEOUT_MS = 3_000
const FORCE_TIMEOUT_MS = 2_000
const KILLER_TIMEOUT_MS = 1_000
const MAX_STDOUT_LINE_BYTES = 14 * 1024 * 1024
const MAX_STDERR_LINE_BYTES = 2 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const MAX_STDERR_LINES = 8

export interface MonitorProcessLogger {
  info: (message: string, context?: unknown) => void
  warn: (message: string, context?: unknown) => void
}

export interface MonitorChild {
  pid?: number | undefined
  stdin: { write: (chunk: string) => unknown }
  stdout: {
    on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
    removeListener: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  }
  stderr: {
    on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
    removeListener: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
  }
  on: {
    (event: 'error', listener: (error: Error) => void): unknown
    (
      event: 'close',
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown
  }
  removeListener: {
    (event: 'error', listener: (error: Error) => void): unknown
    (
      event: 'close',
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown
  }
  kill?: (signal?: NodeJS.Signals) => boolean
}

export type MonitorSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    shell: false
    windowsHide: true
    stdio: ['pipe', 'pipe', 'pipe']
    env: NodeJS.ProcessEnv
  },
) => MonitorChild

export type ProcessTreeKill = (pid: number) => Promise<void>

export interface MonitorTimers {
  setTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

export interface MonitorAction {
  timestamp: string
  width: number
  height: number
  image: Buffer
}

export interface MonitorProcessListener {
  onAction: (action: MonitorAction) => void
  onPredictionResult: (action: MonitorAction) => void
  onFatal: (error: ApplicationError) => void
  onExit: (error: ApplicationError | null) => void
}

interface OwnedProcess {
  generation: number
  sessionId: string
  child: MonitorChild
  listener: MonitorProcessListener
  ready: boolean
  stopping: boolean
  settled: boolean
  lastSequence: number
  stdoutBuffer: Buffer
  stderrBuffer: Buffer
  stderrBytes: number
  stderrLines: number
  readyTimer: ReturnType<typeof setTimeout>
  stopTimer: ReturnType<typeof setTimeout> | null
  forceTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  resolveReady: () => void
  rejectReady: (error: Error) => void
  resolveStopped: (() => void) | null
  rejectStopped: ((error: Error) => void) | null
  handlers: {
    stdout: (chunk: Buffer | string) => void
    stderr: (chunk: Buffer | string) => void
    error: (error: Error) => void
    close: (code: number | null, signal: NodeJS.Signals | null) => void
  }
}

const defaultTimers: MonitorTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
}

const defaultSpawn: MonitorSpawn = (executable, args, options) =>
  nodeSpawn(executable, [...args], options)

export function createDefaultProcessTreeKill(
  spawnCommand: typeof nodeSpawn = nodeSpawn,
  platform = process.platform,
  rootKill: typeof process.kill = (pid, signal) => process.kill(pid, signal),
): ProcessTreeKill {
  return async (pid) => {
    if (platform !== 'win32') {
      rootKill(pid, 'SIGKILL')
      return
    }
    const killed = await new Promise<boolean>((resolve) => {
      let settled = false
      let killer: ReturnType<typeof nodeSpawn> | undefined
      const finish = (success: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolve(success)
      }
      const deadline = setTimeout(() => {
        try {
          killer?.kill('SIGKILL')
        } catch {
          // The root fallback below remains authoritative.
        }
        finish(false)
      }, KILLER_TIMEOUT_MS)
      try {
        killer = spawnCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => finish(false))
        killer.once('close', (code) => finish(code === 0))
      } catch {
        finish(false)
      }
    })
    if (!killed) rootKill(pid, 'SIGKILL')
  }
}

const defaultTreeKill = createDefaultProcessTreeKill()

function pngDimensions(image: Buffer): { width: number; height: number } | null {
  if (
    image.byteLength < 24 ||
    !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    image.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return null
  }
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
}

export class MonitorProcessService {
  #owned: OwnedProcess | null = null
  #generation = 0

  constructor(
    private readonly pythonExecutable: string,
    private readonly scriptPath: string,
    private readonly logger: MonitorProcessLogger,
    private readonly spawn: MonitorSpawn = defaultSpawn,
    private readonly treeKill: ProcessTreeKill = defaultTreeKill,
    private readonly timers: MonitorTimers = defaultTimers,
    private readonly beforeSpawn?: () => Promise<void>,
  ) {}

  async start(
    payload: MonitorStartPayload,
    listener: MonitorProcessListener,
  ): Promise<string> {
    if (this.#owned !== null) {
      throw new ApplicationError(
        'MONITOR_PROCESS_OWNED',
        'A monitor process is already active',
      )
    }
    if (this.beforeSpawn !== undefined) await this.beforeSpawn()
    const generation = ++this.#generation
    const sessionId = randomUUID()
    let child: MonitorChild
    try {
      child = this.spawn(this.pythonExecutable, [this.scriptPath], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
    } catch (cause) {
      throw new ApplicationError(
        'MONITOR_START_FAILED',
        'The monitor worker could not start',
        {
          cause,
        },
      )
    }

    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const owned = {} as OwnedProcess
    Object.assign(owned, {
      generation,
      sessionId,
      child,
      listener,
      ready: false,
      stopping: false,
      settled: false,
      lastSequence: 0,
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
      stderrBytes: 0,
      stderrLines: 0,
      stopTimer: null,
      forceTimer: null,
      killTimer: null,
      resolveReady,
      rejectReady,
      resolveStopped: null,
      rejectStopped: null,
    })
    owned.handlers = {
      stdout: (chunk) => this.handleStdout(owned, chunk),
      stderr: (chunk) => this.handleStderr(owned, chunk),
      error: (error) => this.handleChildError(owned, error),
      close: (code, signal) => this.handleClose(owned, code, signal),
    }
    owned.readyTimer = this.timers.setTimeout(
      () =>
        this.protocolFailure(
          owned,
          'MONITOR_READY_TIMEOUT',
          'The capture source did not become ready',
        ),
      READY_TIMEOUT_MS,
    )
    this.#owned = owned
    child.stdout.on('data', owned.handlers.stdout)
    child.stderr.on('data', owned.handlers.stderr)
    child.on('error', owned.handlers.error)
    child.on('close', owned.handlers.close)

    try {
      const command = MonitorStartCommandSchema.parse({
        protocolVersion: 1,
        sessionId,
        sequence: 0,
        type: 'start',
        payload,
      })
      child.stdin.write(`${JSON.stringify(command)}\n`)
      await readyPromise
      return sessionId
    } catch (error) {
      if (this.#owned === owned && !owned.stopping)
        await this.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    const owned = this.#owned
    if (owned === null) return
    if (owned.resolveStopped !== null) {
      return new Promise<void>((resolve, reject) => {
        const previousResolve = owned.resolveStopped
        const previousReject = owned.rejectStopped
        owned.resolveStopped = () => {
          previousResolve?.()
          resolve()
        }
        owned.rejectStopped = (error) => {
          previousReject?.(error)
          reject(error)
        }
      })
    }
    owned.stopping = true
    this.timers.clearTimeout(owned.readyTimer)
    const stopped = new Promise<void>((resolve, reject) => {
      owned.resolveStopped = resolve
      owned.rejectStopped = reject
    })
    try {
      const command = MonitorStopCommandSchema.parse({
        protocolVersion: 1,
        sessionId: owned.sessionId,
        sequence: owned.lastSequence + 1,
        type: 'stop',
        payload: {},
      })
      owned.child.stdin.write(`${JSON.stringify(command)}\n`)
    } catch {
      this.forceKill(owned)
    }
    owned.stopTimer = this.timers.setTimeout(() => this.forceKill(owned), STOP_TIMEOUT_MS)
    return stopped
  }

  private handleStdout(owned: OwnedProcess, chunk: Buffer | string): void {
    if (!this.isCurrent(owned)) return
    owned.stdoutBuffer = Buffer.concat([owned.stdoutBuffer, Buffer.from(chunk)])
    if (
      owned.stdoutBuffer.byteLength > MAX_STDOUT_LINE_BYTES &&
      !owned.stdoutBuffer.includes(10)
    ) {
      this.protocolFailure(
        owned,
        'MONITOR_PROTOCOL_OVERSIZED',
        'Monitor output line exceeded its limit',
      )
      return
    }
    let newline = owned.stdoutBuffer.indexOf(10)
    while (newline >= 0 && this.isCurrent(owned)) {
      const line = owned.stdoutBuffer.subarray(0, newline)
      owned.stdoutBuffer = owned.stdoutBuffer.subarray(newline + 1)
      if (line.byteLength === 0 || line.byteLength > MAX_STDOUT_LINE_BYTES) {
        this.protocolFailure(
          owned,
          'MONITOR_PROTOCOL_INVALID',
          'Monitor output framing is invalid',
        )
        return
      }
      this.handleLine(owned, line.toString('utf8'))
      newline = owned.stdoutBuffer.indexOf(10)
    }
  }

  private handleLine(owned: OwnedProcess, line: string): void {
    let unknown: unknown
    try {
      unknown = JSON.parse(line) as unknown
    } catch {
      this.protocolFailure(
        owned,
        'MONITOR_PROTOCOL_INVALID',
        'Monitor returned malformed JSON',
      )
      return
    }
    const parsed = MonitorProcessEventSchema.safeParse(unknown)
    if (!parsed.success) {
      this.protocolFailure(
        owned,
        'MONITOR_PROTOCOL_INVALID',
        'Monitor event contract was rejected',
      )
      return
    }
    const event = parsed.data
    if (event.sessionId !== owned.sessionId || event.sequence <= owned.lastSequence) {
      this.protocolFailure(
        owned,
        'MONITOR_PROTOCOL_SEQUENCE',
        'Monitor event sequence is invalid',
      )
      return
    }
    owned.lastSequence = event.sequence
    this.dispatchEvent(owned, event)
  }

  private dispatchEvent(owned: OwnedProcess, event: MonitorProcessEvent): void {
    if (event.type === 'ready') {
      if (owned.ready) {
        this.protocolFailure(
          owned,
          'MONITOR_DUPLICATE_READY',
          'Monitor sent readiness more than once',
        )
        return
      }
      owned.ready = true
      this.timers.clearTimeout(owned.readyTimer)
      owned.resolveReady()
      return
    }
    if (!owned.ready && event.type !== 'fatal' && event.type !== 'stopped') {
      this.protocolFailure(
        owned,
        'MONITOR_PROTOCOL_ORDER',
        'Monitor action arrived before readiness',
      )
      return
    }
    if (event.type === 'action' || event.type === 'prediction_result') {
      const image = Buffer.from(event.payload.imageBase64, 'base64')
      const dimensions = pngDimensions(image)
      if (
        image.toString('base64') !== event.payload.imageBase64 ||
        image.byteLength !== event.payload.byteLength ||
        dimensions?.width !== event.payload.width ||
        dimensions.height !== event.payload.height ||
        dimensions.width * dimensions.height > 20_000_000
      ) {
        this.protocolFailure(
          owned,
          'MONITOR_ACTION_INVALID',
          'Monitor action image is invalid',
        )
        return
      }
      const action = {
        timestamp: event.payload.timestamp,
        width: event.payload.width,
        height: event.payload.height,
        image,
      }
      if (event.type === 'action') owned.listener.onAction(action)
      else owned.listener.onPredictionResult(action)
    } else if (event.type === 'fatal') {
      owned.listener.onFatal(
        new ApplicationError(event.payload.code, event.payload.message),
      )
      void this.stop()
    }
  }

  private handleStderr(owned: OwnedProcess, chunk: Buffer | string): void {
    if (!this.isCurrent(owned)) return
    const bytes = Buffer.from(chunk)
    owned.stderrBytes += bytes.byteLength
    if (owned.stderrBytes > MAX_STDERR_BYTES) {
      this.protocolFailure(
        owned,
        'MONITOR_STDERR_LIMIT',
        'Monitor diagnostics exceeded their limit',
      )
      return
    }
    owned.stderrBuffer = Buffer.concat([owned.stderrBuffer, bytes])
    if (owned.stderrBuffer.byteLength > MAX_STDERR_LINE_BYTES) {
      this.protocolFailure(
        owned,
        'MONITOR_STDERR_LIMIT',
        'Monitor diagnostics exceeded their limit',
      )
      return
    }
    let newline = owned.stderrBuffer.indexOf(10)
    while (newline >= 0) {
      const length = newline
      owned.stderrBuffer = owned.stderrBuffer.subarray(newline + 1)
      owned.stderrLines += 1
      if (length > MAX_STDERR_LINE_BYTES || owned.stderrLines > MAX_STDERR_LINES) {
        this.protocolFailure(
          owned,
          'MONITOR_STDERR_LIMIT',
          'Monitor diagnostics exceeded their limit',
        )
        return
      }
      this.logger.warn('Monitor worker diagnostic suppressed', { bytes: length })
      newline = owned.stderrBuffer.indexOf(10)
    }
  }

  private handleChildError(owned: OwnedProcess, error: Error): void {
    if (!this.isCurrent(owned)) return
    this.protocolFailure(
      owned,
      'MONITOR_START_FAILED',
      'The monitor worker failed to start',
      error,
    )
  }

  private handleClose(
    owned: OwnedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (!this.isCurrent(owned)) return
    const expected = owned.stopping
    this.cleanup(owned)
    if (!owned.ready && !owned.settled) {
      owned.settled = true
      owned.rejectReady(
        new ApplicationError(
          'MONITOR_EXITED_EARLY',
          'The monitor worker exited before readiness',
        ),
      )
    }
    owned.resolveStopped?.()
    owned.listener.onExit(
      expected
        ? null
        : new ApplicationError(
            'MONITOR_PROCESS_EXITED',
            `The monitor worker stopped unexpectedly (${code ?? signal ?? 'unknown'})`,
          ),
    )
  }

  private protocolFailure(
    owned: OwnedProcess,
    code: string,
    message: string,
    cause?: Error,
  ): void {
    if (!this.isCurrent(owned)) return
    const error = new ApplicationError(
      code,
      message,
      cause === undefined ? undefined : { cause },
    )
    if (!owned.ready && !owned.settled) {
      owned.settled = true
      owned.rejectReady(error)
    } else if (!owned.stopping) {
      owned.listener.onFatal(error)
    }
    this.forceKill(owned)
  }

  private forceKill(owned: OwnedProcess): void {
    if (!this.isCurrent(owned) || owned.forceTimer !== null) return
    owned.stopping = true
    owned.forceTimer = this.timers.setTimeout(() => {
      if (!this.isCurrent(owned)) return
      const error = new ApplicationError(
        'MONITOR_STOP_TIMEOUT',
        'The monitor worker did not stop',
      )
      this.cleanup(owned)
      owned.rejectStopped?.(error)
    }, FORCE_TIMEOUT_MS)
    const pid = owned.child.pid
    if (pid === undefined || pid <= 0) return
    let killSettled = false
    const finishKill = (fallback: boolean): void => {
      if (killSettled || !this.isCurrent(owned)) return
      killSettled = true
      if (owned.killTimer !== null) this.timers.clearTimeout(owned.killTimer)
      owned.killTimer = null
      if (!fallback) return
      try {
        if (owned.child.kill !== undefined) owned.child.kill('SIGKILL')
        else process.kill(pid, 'SIGKILL')
      } catch {
        // The close event or final cleanup deadline remains authoritative.
      }
    }
    owned.killTimer = this.timers.setTimeout(() => finishKill(true), KILLER_TIMEOUT_MS)
    void Promise.resolve()
      .then(() => this.treeKill(pid))
      .then(
        () => finishKill(false),
        () => finishKill(true),
      )
  }

  private cleanup(owned: OwnedProcess): void {
    this.timers.clearTimeout(owned.readyTimer)
    if (owned.stopTimer !== null) this.timers.clearTimeout(owned.stopTimer)
    if (owned.forceTimer !== null) this.timers.clearTimeout(owned.forceTimer)
    if (owned.killTimer !== null) this.timers.clearTimeout(owned.killTimer)
    owned.child.stdout.removeListener('data', owned.handlers.stdout)
    owned.child.stderr.removeListener('data', owned.handlers.stderr)
    owned.child.removeListener('error', owned.handlers.error)
    owned.child.removeListener('close', owned.handlers.close)
    owned.stdoutBuffer = Buffer.alloc(0)
    owned.stderrBuffer = Buffer.alloc(0)
    if (this.#owned === owned) this.#owned = null
  }

  private isCurrent(owned: OwnedProcess): boolean {
    return this.#owned === owned && owned.generation === this.#generation
  }
}
