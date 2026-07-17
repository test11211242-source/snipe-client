import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'
import { PixelSizeSchema } from '../../../shared/models/capture'
import type { SetupCaptureSelector } from '../domain/capture-source'
import {
  BinaryEnvelopeStreamDecoder,
  encodeBinaryEnvelope,
  type BinaryEnvelope,
} from './binary-protocol'
import type { CapturedFrame } from './capture-service'
import {
  createDefaultProcessTreeKill,
  type ProcessTreeKill,
} from './monitor-process-service'

const READY_TIMEOUT_MS = 8_000
const FREEZE_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 3_000
const MAX_METADATA_BYTES = 64 * 1024
const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const MAX_PIXELS = 20_000_000

const EventSchema = z
  .object({
    protocolVersion: z.literal(1),
    sessionId: z.uuid(),
    sequence: z.number().int().positive(),
    type: z.enum(['ready', 'frozen', 'fatal', 'stopped']),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

const ReadyPayloadSchema = z
  .object({
    frameSequence: z.number().int().positive(),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  })
  .strict()

const FrozenPayloadSchema = ReadyPayloadSchema.extend({
  mimeType: z.literal('image/png'),
  byteLength: z.number().int().positive().max(MAX_PNG_BYTES),
}).strict()

const FatalPayloadSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(300),
  })
  .strict()

export interface PreparedCaptureProcessLogger {
  warn: (message: string, context?: unknown) => void
}

export interface PreparedCaptureChild extends EventEmitter {
  pid?: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: (signal?: NodeJS.Signals) => boolean
}

export type PreparedCaptureSpawn = (
  executable: string,
  args: readonly string[],
  options: {
    shell: false
    windowsHide: true
    stdio: ['pipe', 'pipe', 'pipe']
    env: NodeJS.ProcessEnv
  },
) => PreparedCaptureChild

interface OwnedProcess {
  generation: number
  sessionId: string
  child: PreparedCaptureChild
  decoder: BinaryEnvelopeStreamDecoder
  lastSequence: number
  ready: boolean
  stopping: boolean
  stderrBytes: number
  readyTimer: ReturnType<typeof setTimeout>
  freezeTimer: ReturnType<typeof setTimeout> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  resolveReady: (value: {
    sessionId: string
    size: { width: number; height: number }
  }) => void
  rejectReady: (error: Error) => void
  resolveFreeze: ((frame: CapturedFrame) => void) | null
  rejectFreeze: ((error: Error) => void) | null
  resolveStop: (() => void) | null
  handlers: {
    stdinError: (error: Error) => void
    stdout: (chunk: Buffer | string) => void
    stderr: (chunk: Buffer | string) => void
    error: (error: Error) => void
    close: (code: number | null, signal: NodeJS.Signals | null) => void
  }
}

const defaultSpawn: PreparedCaptureSpawn = (executable, args, options) =>
  nodeSpawn(executable, [...args], options) as PreparedCaptureChild

function workerSelector(selector: SetupCaptureSelector): unknown {
  return selector.kind === 'window'
    ? { kind: 'window', windowHwnd: selector.windowHwnd }
    : {
        kind: 'display',
        displayDeviceName: selector.displayDeviceName,
        electronDisplayId: selector.electronDisplayId,
      }
}

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

export class PreparedCaptureProcessService {
  #owned: OwnedProcess | null = null
  #generation = 0
  #starting = false

  constructor(
    private readonly pythonExecutable: string,
    private readonly scriptPath: string,
    private readonly logger: PreparedCaptureProcessLogger,
    private readonly spawn: PreparedCaptureSpawn = defaultSpawn,
    private readonly treeKill: ProcessTreeKill = createDefaultProcessTreeKill(),
    private readonly beforeSpawn?: () => Promise<void>,
  ) {}

  async start(
    selector: SetupCaptureSelector,
  ): Promise<{ sessionId: string; size: { width: number; height: number } }> {
    if (this.#owned !== null || this.#starting) {
      throw new ApplicationError(
        'CAPTURE_PREPARATION_OWNED',
        'A capture source is already prepared',
      )
    }
    const generation = ++this.#generation
    this.#starting = true
    try {
      if (this.beforeSpawn !== undefined) await this.beforeSpawn()
    } catch (error) {
      if (generation === this.#generation) this.#starting = false
      throw error
    }
    if (generation !== this.#generation) {
      throw new ApplicationError(
        'CAPTURE_PREPARATION_CANCELLED',
        'Capture preparation was cancelled',
      )
    }

    const sessionId = randomUUID()
    let child: PreparedCaptureChild
    try {
      child = this.spawn(this.pythonExecutable, [this.scriptPath], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
    } catch (cause) {
      this.#starting = false
      throw new ApplicationError(
        'CAPTURE_PREPARATION_START_FAILED',
        'The selected source could not be prepared',
        { cause },
      )
    }

    let resolveReady!: OwnedProcess['resolveReady']
    let rejectReady!: OwnedProcess['rejectReady']
    const readyPromise = new Promise<{
      sessionId: string
      size: { width: number; height: number }
    }>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const owned = {} as OwnedProcess
    Object.assign(owned, {
      generation,
      sessionId,
      child,
      decoder: new BinaryEnvelopeStreamDecoder({
        maxMetadataBytes: MAX_METADATA_BYTES,
        maxBinaryBytes: MAX_PNG_BYTES,
      }),
      lastSequence: 0,
      ready: false,
      stopping: false,
      stderrBytes: 0,
      freezeTimer: null,
      stopTimer: null,
      resolveReady,
      rejectReady,
      resolveFreeze: null,
      rejectFreeze: null,
      resolveStop: null,
    })
    owned.handlers = {
      stdinError: (error) =>
        this.fail(owned, 'CAPTURE_PREPARATION_PROTOCOL_WRITE_FAILED', error),
      stdout: (chunk) => this.handleStdout(owned, chunk),
      stderr: (chunk) => this.handleStderr(owned, chunk),
      error: (error) => this.fail(owned, 'CAPTURE_PREPARATION_START_FAILED', error),
      close: (code, signal) => this.handleClose(owned, code, signal),
    }
    owned.readyTimer = setTimeout(
      () =>
        this.fail(
          owned,
          'CAPTURE_PREPARATION_TIMEOUT',
          new Error('Capture source did not become ready'),
        ),
      READY_TIMEOUT_MS,
    )
    this.#owned = owned
    this.#starting = false
    child.stdin.on('error', owned.handlers.stdinError)
    child.stdout.on('data', owned.handlers.stdout)
    child.stderr.on('data', owned.handlers.stderr)
    child.on('error', owned.handlers.error)
    child.on('close', owned.handlers.close)
    try {
      child.stdin.write(
        encodeBinaryEnvelope({
          protocolVersion: 1,
          sessionId,
          type: 'start',
          selector: workerSelector(selector),
        }),
      )
      return await readyPromise
    } catch (error) {
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  freeze(sessionId: string, signal?: AbortSignal): Promise<CapturedFrame> {
    const owned = this.#owned
    if (
      owned?.sessionId !== sessionId ||
      !owned.ready ||
      owned.stopping ||
      owned.resolveFreeze !== null
    ) {
      return Promise.reject(
        new ApplicationError(
          'CAPTURE_PREPARATION_STALE',
          'The selected source is no longer prepared',
        ),
      )
    }
    if (signal?.aborted === true) {
      return Promise.reject(
        new ApplicationError('CAPTURE_PREPARATION_CANCELLED', 'Capture was cancelled'),
      )
    }
    return new Promise<CapturedFrame>((resolve, reject) => {
      const abort = (): void => {
        reject(
          new ApplicationError('CAPTURE_PREPARATION_CANCELLED', 'Capture was cancelled'),
        )
        void this.stop()
      }
      owned.resolveFreeze = (frame) => {
        signal?.removeEventListener('abort', abort)
        resolve(frame)
      }
      owned.rejectFreeze = (error) => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      signal?.addEventListener('abort', abort, { once: true })
      owned.freezeTimer = setTimeout(
        () =>
          this.fail(
            owned,
            'CAPTURE_FREEZE_TIMEOUT',
            new Error('Prepared frame did not freeze in time'),
          ),
        FREEZE_TIMEOUT_MS,
      )
      try {
        owned.child.stdin.write(
          encodeBinaryEnvelope({
            protocolVersion: 1,
            sessionId,
            type: 'freeze',
          }),
        )
      } catch (cause) {
        clearTimeout(owned.freezeTimer)
        owned.freezeTimer = null
        owned.resolveFreeze = null
        owned.rejectFreeze = null
        signal?.removeEventListener('abort', abort)
        reject(
          new ApplicationError(
            'CAPTURE_PREPARATION_PROTOCOL_WRITE_FAILED',
            'The selected source capture failed',
            { cause },
          ),
        )
        void this.stop()
      }
    })
  }

  async stop(): Promise<void> {
    if (this.#starting) {
      this.#starting = false
      ++this.#generation
    }
    const owned = this.#owned
    if (owned === null) return
    const pendingStop = owned.resolveStop
    if (pendingStop !== null) {
      return new Promise<void>((resolve) => {
        owned.resolveStop = () => {
          pendingStop()
          resolve()
        }
      })
    }
    owned.stopping = true
    clearTimeout(owned.readyTimer)
    const stopped = new Promise<void>((resolve) => {
      owned.resolveStop = resolve
    })
    try {
      owned.child.stdin.write(
        encodeBinaryEnvelope({
          protocolVersion: 1,
          sessionId: owned.sessionId,
          type: 'stop',
        }),
      )
    } catch {
      void this.kill(owned)
    }
    owned.stopTimer = setTimeout(() => void this.kill(owned), STOP_TIMEOUT_MS)
    return stopped
  }

  private handleStdout(owned: OwnedProcess, chunk: Buffer | string): void {
    if (!this.current(owned)) return
    try {
      for (const envelope of owned.decoder.push(Buffer.from(chunk))) {
        this.handleEnvelope(owned, envelope)
      }
    } catch (error) {
      this.fail(
        owned,
        'CAPTURE_PREPARATION_PROTOCOL_INVALID',
        error instanceof Error ? error : new Error('Invalid capture protocol'),
      )
    }
  }

  private handleEnvelope(owned: OwnedProcess, envelope: BinaryEnvelope): void {
    const event = EventSchema.parse(envelope.metadata)
    if (event.sessionId !== owned.sessionId || event.sequence <= owned.lastSequence) {
      throw new ApplicationError(
        'CAPTURE_PREPARATION_PROTOCOL_SEQUENCE',
        'Prepared capture event sequence is invalid',
      )
    }
    owned.lastSequence = event.sequence
    if (event.type === 'ready') {
      if (owned.ready || envelope.binary.byteLength !== 0) {
        throw new ApplicationError(
          'CAPTURE_PREPARATION_PROTOCOL_ORDER',
          'Prepared capture readiness is invalid',
        )
      }
      const payload = ReadyPayloadSchema.parse(event.payload)
      const size = PixelSizeSchema.parse({ width: payload.width, height: payload.height })
      if (size.width * size.height > MAX_PIXELS) throw new Error('Frame is too large')
      owned.ready = true
      clearTimeout(owned.readyTimer)
      owned.resolveReady({ sessionId: owned.sessionId, size })
      return
    }
    if (event.type === 'fatal') {
      const payload = FatalPayloadSchema.parse(event.payload)
      this.fail(owned, payload.code, new Error(payload.message))
      return
    }
    if (event.type === 'stopped') {
      if (!owned.stopping || envelope.binary.byteLength !== 0) {
        throw new Error('Unexpected stopped event')
      }
      return
    }
    if (!owned.ready || owned.resolveFreeze === null || owned.stopping) {
      throw new Error('Frozen frame arrived out of order')
    }
    const payload = FrozenPayloadSchema.parse(event.payload)
    const dimensions = pngDimensions(envelope.binary)
    if (
      payload.byteLength !== envelope.binary.byteLength ||
      dimensions?.width !== payload.width ||
      dimensions.height !== payload.height ||
      dimensions.width * dimensions.height > MAX_PIXELS
    ) {
      throw new Error('Frozen frame is invalid')
    }
    if (owned.freezeTimer !== null) clearTimeout(owned.freezeTimer)
    owned.freezeTimer = null
    owned.stopping = true
    const resolve = owned.resolveFreeze
    owned.resolveFreeze = null
    owned.rejectFreeze = null
    resolve({
      size: { width: payload.width, height: payload.height },
      png: Buffer.from(envelope.binary),
    })
  }

  private handleStderr(owned: OwnedProcess, chunk: Buffer | string): void {
    if (!this.current(owned)) return
    owned.stderrBytes += Buffer.byteLength(chunk)
    if (owned.stderrBytes > MAX_STDERR_BYTES) {
      this.fail(
        owned,
        'CAPTURE_PREPARATION_DIAGNOSTICS_LIMIT',
        new Error('Capture diagnostics exceeded limits'),
      )
    } else {
      this.logger.warn('Prepared capture diagnostic suppressed', {
        bytes: Buffer.byteLength(chunk),
      })
    }
  }

  private handleClose(
    owned: OwnedProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (!this.current(owned)) return
    try {
      owned.decoder.finish()
    } catch (error) {
      if (!owned.stopping) {
        this.rejectPending(
          owned,
          error instanceof Error ? error : new Error('Capture output was truncated'),
        )
      }
    }
    const expected = owned.stopping
    if (!expected) {
      this.rejectPending(
        owned,
        new ApplicationError(
          'CAPTURE_PREPARATION_EXITED',
          `Prepared capture stopped unexpectedly (${code ?? signal ?? 'unknown'})`,
        ),
      )
    }
    const resolveStop = owned.resolveStop
    this.cleanup(owned)
    resolveStop?.()
  }

  private fail(owned: OwnedProcess, code: string, cause: Error): void {
    if (!this.current(owned)) return
    const error = new ApplicationError(code, 'The selected source capture failed', {
      cause,
    })
    this.rejectPending(owned, error)
    void this.kill(owned)
  }

  private rejectPending(owned: OwnedProcess, error: Error): void {
    if (!owned.ready) owned.rejectReady(error)
    owned.rejectFreeze?.(error)
    owned.resolveFreeze = null
    owned.rejectFreeze = null
  }

  private async kill(owned: OwnedProcess): Promise<void> {
    if (!this.current(owned)) return
    owned.stopping = true
    const pid = owned.child.pid
    try {
      if (pid !== undefined && pid > 0) await this.treeKill(pid)
      else owned.child.kill('SIGKILL')
    } catch {
      try {
        owned.child.kill('SIGKILL')
      } catch {
        // The close event remains authoritative.
      }
    }
  }

  private cleanup(owned: OwnedProcess): void {
    clearTimeout(owned.readyTimer)
    if (owned.freezeTimer !== null) clearTimeout(owned.freezeTimer)
    if (owned.stopTimer !== null) clearTimeout(owned.stopTimer)
    owned.child.stdin.removeListener('error', owned.handlers.stdinError)
    owned.child.stdout.removeListener('data', owned.handlers.stdout)
    owned.child.stderr.removeListener('data', owned.handlers.stderr)
    owned.child.removeListener('error', owned.handlers.error)
    owned.child.removeListener('close', owned.handlers.close)
    if (this.#owned === owned) this.#owned = null
  }

  private current(owned: OwnedProcess): boolean {
    return this.#owned === owned && owned.generation === this.#generation
  }
}
