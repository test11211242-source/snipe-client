import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import {
  MONITOR_MAX_COMMAND_LINE_BYTES,
  MONITOR_PROTOCOL_VERSION,
  MonitorProcessEventSchema,
  MonitorStartCommandSchema,
  MonitorStopCommandSchema,
  type MonitorProcessEvent,
  type MonitorStartPayload,
  type MonitorGeometryEvent,
  type MonitorLearningEvent,
  type MonitorLayoutLearnedEvent,
  type MonitorPredictionStateEvent,
  type MonitorSourceStateEvent,
} from '../../../shared/contracts/monitor-protocol'
import { pythonWorkerEnvironment } from './python-environment'

// Python owns its 7-second no-frame deadline; allow 8 seconds for cold startup.
const READY_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 3_000
const FORCE_TIMEOUT_MS = 2_000
const KILLER_TIMEOUT_MS = 1_000
const MAX_STDOUT_LINE_BYTES = 14 * 1024 * 1024
const MAX_STDERR_LINE_BYTES = 2 * 1024
const STDERR_REPORT_INTERVAL_MS = 5_000

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
  now?: () => number
}

export interface MonitorAction {
  timestamp: string
  triggerId?: string
  width: number
  height: number
  image: Buffer
}

export interface MonitorProcessListener {
  onTriggered: (timestamp: string, triggerId?: string) => void
  onAction: (action: MonitorAction) => void
  onPredictionResult: (action: MonitorAction) => void
  onGeometry?: (payload: MonitorGeometryEvent['payload']) => void
  onLearning?: (payload: MonitorLearningEvent['payload']) => void
  onLayoutLearned?: (payload: MonitorLayoutLearnedEvent['payload']) => void
  onPredictionState?: (payload: MonitorPredictionStateEvent['payload']) => void
  onSourceState?: (payload: MonitorSourceStateEvent['payload']) => void
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
  /** Last logged geometry state and layout; geometry lines are written on change only. */
  loggedGeometry: string | null
  stdoutBuffer: Buffer
  stderrLineBytes: number
  stderrReportAt: number
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

interface PendingStart {
  generation: number
  cancelled: Promise<never>
  cancel: (error: ApplicationError) => void
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
  #starting: PendingStart | null = null
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
    if (this.#owned !== null || this.#starting !== null) {
      throw new ApplicationError(
        'MONITOR_PROCESS_OWNED',
        'A monitor process is already active',
      )
    }
    const generation = ++this.#generation
    let cancel!: (error: ApplicationError) => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = reject
    })
    const starting = { generation, cancelled, cancel }
    this.#starting = starting
    try {
      if (this.beforeSpawn !== undefined) {
        await Promise.race([this.beforeSpawn(), starting.cancelled])
      }
    } catch (error) {
      if (this.#starting === starting) this.#starting = null
      throw error
    }
    if (this.#starting !== starting || generation !== this.#generation) {
      throw new ApplicationError('MONITOR_START_CANCELLED', 'Monitor start was cancelled')
    }
    const sessionId = randomUUID()
    let commandLine: string
    try {
      commandLine = JSON.stringify(
        MonitorStartCommandSchema.parse({
          protocolVersion: MONITOR_PROTOCOL_VERSION,
          sessionId,
          sequence: 0,
          type: 'start',
          payload,
        }),
      )
      if (Buffer.byteLength(commandLine, 'utf8') + 1 > MONITOR_MAX_COMMAND_LINE_BYTES) {
        throw new ApplicationError(
          'MONITOR_PROTOCOL_OVERSIZED',
          'Monitor command line exceeded its limit',
        )
      }
    } catch (error) {
      if (this.#starting === starting) this.#starting = null
      throw error
    }
    let child: MonitorChild
    try {
      child = this.spawn(this.pythonExecutable, ['-B', this.scriptPath], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: pythonWorkerEnvironment({ PYTHONUNBUFFERED: '1' }),
      })
    } catch (cause) {
      if (this.#starting === starting) this.#starting = null
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
      loggedGeometry: null,
      stdoutBuffer: Buffer.alloc(0),
      stderrLineBytes: 0,
      stderrReportAt: 0,
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
    this.#starting = null
    child.stdout.on('data', owned.handlers.stdout)
    child.stderr.on('data', owned.handlers.stderr)
    child.on('error', owned.handlers.error)
    child.on('close', owned.handlers.close)

    try {
      child.stdin.write(`${commandLine}\n`)
      await readyPromise
      return sessionId
    } catch (error) {
      if (this.#owned === owned && !owned.stopping)
        await this.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    const starting = this.#starting
    if (starting !== null) {
      this.#starting = null
      ++this.#generation
      starting.cancel(
        new ApplicationError('MONITOR_START_CANCELLED', 'Monitor start was cancelled'),
      )
    }
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
        protocolVersion: MONITOR_PROTOCOL_VERSION,
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
    if (event.type === 'triggered') {
      owned.listener.onTriggered(event.payload.timestamp, event.payload.triggerId)
    } else if (event.type === 'diagnostic') {
      this.logger.info('Trigger diagnostic', event.payload)
    } else if (event.type === 'vs_candidate') {
      this.logger.info('VS candidate', event.payload)
    } else if (event.type === 'geometry') {
      this.logGeometry(owned, event.payload)
      owned.listener.onGeometry?.(event.payload)
    } else if (event.type === 'learning') {
      this.logger.info('Monitor learning', {
        status: event.payload.status,
        code: event.payload.reason,
        rejectedCount: event.payload.rejectedCount,
      })
      owned.listener.onLearning?.(event.payload)
    } else if (event.type === 'layout_learned') {
      this.logger.info('Monitor layout learned', {
        gameAspect: event.payload.layout.gameAspect,
        gameRect: event.payload.layout.referenceGameRect,
        fired: event.payload.triggerId !== null,
      })
      owned.listener.onLayoutLearned?.(event.payload)
    } else if (event.type === 'prediction_state') {
      owned.listener.onPredictionState?.(event.payload)
    } else if (event.type === 'source_state') {
      this.logger.info('Monitor source state', { minimized: event.payload.minimized })
      owned.listener.onSourceState?.(event.payload)
    } else if (event.type === 'action' || event.type === 'prediction_result') {
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
        triggerId: event.payload.triggerId,
        width: event.payload.width,
        height: event.payload.height,
        image,
      }
      if (event.type === 'action') owned.listener.onAction(action)
      else owned.listener.onPredictionResult(action)
    } else if (event.type === 'fatal') {
      this.logger.warn('Monitor worker fatal', {
        code: event.payload.code,
        stage: event.payload.stage,
        errorClass: event.payload.errorClass,
      })
      const error = new ApplicationError(event.payload.code, event.payload.message)
      if (!owned.ready && !owned.settled) {
        owned.settled = true
        this.timers.clearTimeout(owned.readyTimer)
        owned.rejectReady(error)
      }
      owned.listener.onFatal(error)
      void this.stop()
    }
  }

  /** One line per geometry state or layout change; rect jitter is not logged. */
  private logGeometry(
    owned: OwnedProcess,
    geometry: MonitorGeometryEvent['payload'],
  ): void {
    const key = `${geometry.state}|${geometry.layoutId ?? ''}`
    if (owned.loggedGeometry === key) return
    owned.loggedGeometry = key
    this.logger.info('Monitor geometry', {
      state: geometry.state,
      frameWidth: geometry.frameWidth,
      frameHeight: geometry.frameHeight,
      gameRect: geometry.gameRect,
      gameAspect:
        geometry.gameAspect === null ? null : Number(geometry.gameAspect.toFixed(4)),
      hasLayout: geometry.layoutId !== null,
    })
  }

  private handleStderr(owned: OwnedProcess, chunk: Buffer | string): void {
    if (!this.isCurrent(owned)) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    owned.stderrBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      owned.stderrBytes + bytes.length,
    )
    let offset = 0
    let newline = bytes.indexOf(10)
    while (newline >= 0) {
      owned.stderrLines = Math.min(Number.MAX_SAFE_INTEGER, owned.stderrLines + 1)
      owned.stderrLineBytes = 0
      offset = newline + 1
      newline = bytes.indexOf(10, offset)
    }
    owned.stderrLineBytes = Math.min(
      MAX_STDERR_LINE_BYTES,
      owned.stderrLineBytes + bytes.length - offset,
    )
    const now = (this.timers.now ?? Date.now)()
    if (now >= owned.stderrReportAt) {
      this.logger.warn('Monitor worker diagnostics suppressed', {
        bytes: owned.stderrBytes,
        lines: owned.stderrLines,
        incompleteLineBytes: owned.stderrLineBytes,
      })
      owned.stderrBytes = 0
      owned.stderrLines = 0
      owned.stderrReportAt = now + STDERR_REPORT_INTERVAL_MS
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
    if (owned.stderrBytes > 0) {
      this.logger.warn('Monitor final diagnostics suppressed', {
        bytes: owned.stderrBytes,
        lines: owned.stderrLines,
        incompleteLineBytes: owned.stderrLineBytes,
      })
      owned.stderrBytes = 0
      owned.stderrLines = 0
    }
    this.timers.clearTimeout(owned.readyTimer)
    if (owned.stopTimer !== null) this.timers.clearTimeout(owned.stopTimer)
    if (owned.forceTimer !== null) this.timers.clearTimeout(owned.forceTimer)
    if (owned.killTimer !== null) this.timers.clearTimeout(owned.killTimer)
    owned.child.stdout.removeListener('data', owned.handlers.stdout)
    owned.child.stderr.removeListener('data', owned.handlers.stderr)
    owned.child.removeListener('error', owned.handlers.error)
    owned.child.removeListener('close', owned.handlers.close)
    owned.stdoutBuffer = Buffer.alloc(0)
    if (this.#owned === owned) this.#owned = null
  }

  private isCurrent(owned: OwnedProcess): boolean {
    return this.#owned === owned && owned.generation === this.#generation
  }
}
