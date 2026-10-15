import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

import { z } from 'zod'

import {
  AnalysisProgressSchema,
  AnalysisResultSchema,
  DetectionPreviewSchema,
  type AnalysisProgress,
  type AnalysisResult,
  type AutoSetupCode,
  type DetectionPreview,
} from '../../../shared/contracts/auto-setup'
import { ApplicationError } from '../../../shared/errors/application-error'
import { PixelSizeSchema } from '../../../shared/models/capture'
import type { SetupCaptureSelector } from '../domain/capture-source'
import {
  BinaryEnvelopeStreamDecoder,
  encodeBinaryEnvelope,
  type BinaryEnvelope,
} from './binary-protocol'
import { PreparedCaptureGameSchema, type CapturedFrame } from './capture-service'
import {
  createDefaultProcessTreeKill,
  type ProcessTreeKill,
} from './monitor-process-service'
import { pythonWorkerEnvironment } from './python-environment'

const READY_TIMEOUT_MS = 8_000
const FREEZE_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 3_000
const ANALYSIS_TIMEOUT_MS = 65_000
const CANCEL_TIMEOUT_MS = 5_000
// Four bounded chrome strip templates can exceed the old 64 KiB event limit.
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const MAX_PIXELS = 20_000_000

const EventSchema = z
  .object({
    protocolVersion: z.literal(2),
    sessionId: z.uuid(),
    sequence: z.number().int().positive(),
    type: z.enum([
      'ready',
      'frozen',
      'fatal',
      'stopped',
      'analysis_progress',
      'analysis_preview',
      'analysis_result',
      'analysis_cancelled',
    ]),
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
  game: PreparedCaptureGameSchema,
}).strict()

const FatalPayloadSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(300),
  })
  .strict()

const PreviewPayloadSchema = z
  .object({
    width: DetectionPreviewSchema.shape.width,
    height: DetectionPreviewSchema.shape.height,
    mimeType: DetectionPreviewSchema.shape.mimeType,
    byteLength: DetectionPreviewSchema.shape.byteLength,
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
  analysis: {
    resolve: (value: { result: AnalysisResult; frame: CapturedFrame | null }) => void
    reject: (error: Error) => void
    onProgress: (progress: AnalysisProgress) => void
    onPreview: (preview: DetectionPreview) => void
    timer: NodeJS.Timeout
    detachAbort: () => void
    elapsedMs: number
    framesAnalyzed: number
  } | null
  cancellation: {
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  } | null
  size: { width: number; height: number } | null
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

function jpegDimensions(image: Buffer): { width: number; height: number } | null {
  if (
    image.byteLength < 4 ||
    image.readUInt16BE(0) !== 0xffd8 ||
    image.readUInt16BE(image.byteLength - 2) !== 0xffd9
  )
    return null
  let offset = 2
  while (offset + 4 <= image.byteLength) {
    if (image[offset] !== 0xff) return null
    while (image[offset] === 0xff) offset++
    const marker = image[offset++]
    if (marker === 0xda || marker === 0xd9 || marker === undefined) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > image.byteLength) return null
    const length = image.readUInt16BE(offset)
    if (length < 2 || offset + length > image.byteLength) return null
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null
      return {
        width: image.readUInt16BE(offset + 5),
        height: image.readUInt16BE(offset + 3),
      }
    }
    offset += length
  }
  return null
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
      child = this.spawn(this.pythonExecutable, ['-B', this.scriptPath], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: pythonWorkerEnvironment({ PYTHONUNBUFFERED: '1' }),
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
      analysis: null,
      cancellation: null,
      size: null,
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
          protocolVersion: 2,
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

  isAlive(sessionId: string): boolean {
    const owned = this.#owned
    return owned?.sessionId === sessionId && owned.ready && !owned.stopping
  }

  getSize(sessionId: string): { width: number; height: number } | null {
    return this.#owned?.sessionId === sessionId ? this.#owned.size : null
  }

  async analyze(
    sessionId: string,
    onProgress: (progress: AnalysisProgress) => void,
    onPreview: (preview: DetectionPreview) => void,
    signal?: AbortSignal,
  ): Promise<{ result: AnalysisResult; frame: CapturedFrame | null }> {
    const owned = this.#owned
    if (owned?.sessionId !== sessionId || !this.isAlive(sessionId)) {
      throw new ApplicationError(
        'CAPTURE_PREPARATION_STALE',
        'Capture is no longer available',
      )
    }
    if (owned.cancellation !== null) await owned.cancellation.promise
    if (!this.current(owned) || owned.stopping) {
      return { result: { ok: false, code: 'AUTO_SOURCE_LOST' }, frame: null }
    }
    if (owned.analysis !== null || owned.resolveFreeze !== null) {
      throw new ApplicationError(
        'CAPTURE_PREPARATION_OWNED',
        'Capture already has an active operation',
      )
    }
    if (signal?.aborted) {
      throw new ApplicationError('CAPTURE_PREPARATION_CANCELLED', 'Capture was cancelled')
    }
    const { promise, resolve, reject } = Promise.withResolvers<{
      result: AnalysisResult
      frame: CapturedFrame | null
    }>()
    const abort = (): void => {
      void this.cancelAnalysis(sessionId).catch(() => undefined)
    }
    owned.analysis = {
      resolve,
      reject,
      onProgress,
      onPreview,
      elapsedMs: 0,
      framesAnalyzed: 0,
      detachAbort: () => signal?.removeEventListener('abort', abort),
      timer: setTimeout(() => {
        this.fail(
          owned,
          'AUTO_INTERNAL_TIMEOUT',
          new Error('Analysis deadline exceeded'),
          'AUTO_INTERNAL_TIMEOUT',
        )
      }, ANALYSIS_TIMEOUT_MS),
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      owned.child.stdin.write(
        encodeBinaryEnvelope({
          protocolVersion: 2,
          sessionId,
          type: 'analyze',
          deadlineMs: 60_000,
          targetFps: 10,
        }),
      )
    } catch (cause) {
      this.fail(
        owned,
        'AUTO_INTERNAL_ERROR',
        cause instanceof Error ? cause : new Error('Analysis write failed'),
      )
    }
    return promise
  }

  cancelAnalysis(sessionId: string): Promise<void> {
    const owned = this.#owned
    if (owned?.sessionId !== sessionId || owned.stopping) return Promise.resolve()
    if (owned.cancellation !== null) return owned.cancellation.promise
    const analysis = owned.analysis
    if (analysis === null) return Promise.resolve()
    owned.analysis = null
    clearTimeout(analysis.timer)
    analysis.detachAbort()
    analysis.reject(
      new ApplicationError('CAPTURE_PREPARATION_CANCELLED', 'Capture was cancelled'),
    )
    const { promise, resolve, reject } = Promise.withResolvers<undefined>()
    owned.cancellation = {
      promise,
      resolve: () => resolve(undefined),
      reject,
      timer: setTimeout(() => {
        this.fail(
          owned,
          'AUTO_INTERNAL_TIMEOUT',
          new Error('Analysis cancellation exceeded deadline'),
        )
      }, CANCEL_TIMEOUT_MS),
    }
    try {
      owned.child.stdin.write(
        encodeBinaryEnvelope({
          protocolVersion: 2,
          sessionId,
          type: 'analyze_cancel',
        }),
      )
    } catch (cause) {
      this.fail(
        owned,
        'AUTO_INTERNAL_ERROR',
        cause instanceof Error ? cause : new Error('Analysis cancellation failed'),
      )
    }
    return promise
  }

  freeze(sessionId: string, signal?: AbortSignal): Promise<CapturedFrame> {
    const owned = this.#owned
    if (
      owned?.sessionId !== sessionId ||
      !owned.ready ||
      owned.stopping ||
      owned.resolveFreeze !== null ||
      owned.analysis !== null ||
      owned.cancellation !== null
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
        void this.stop(sessionId)
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
            protocolVersion: 2,
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

  async stop(sessionId?: string): Promise<void> {
    if (sessionId !== undefined && this.#owned?.sessionId !== sessionId) return
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
    const analysis = owned.analysis
    if (analysis !== null) {
      owned.analysis = null
      clearTimeout(analysis.timer)
      analysis.detachAbort()
      analysis.reject(
        new ApplicationError('CAPTURE_PREPARATION_CANCELLED', 'Capture was cancelled'),
      )
    }
    this.rejectPending(
      owned,
      new ApplicationError('CAPTURE_PREPARATION_CANCELLED', 'Capture was cancelled'),
    )
    clearTimeout(owned.readyTimer)
    const stopped = new Promise<void>((resolve) => {
      owned.resolveStop = resolve
    })
    try {
      owned.child.stdin.write(
        encodeBinaryEnvelope({
          protocolVersion: 2,
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
      owned.size = size
      owned.ready = true
      clearTimeout(owned.readyTimer)
      owned.resolveReady({ sessionId: owned.sessionId, size })
      return
    }
    if (event.type === 'fatal') {
      const payload = FatalPayloadSchema.parse(event.payload)
      if (envelope.binary.byteLength !== 0) throw new Error('Fatal event has binary data')
      this.fail(
        owned,
        payload.code,
        new Error(payload.message),
        payload.code === 'CAPTURE_SOURCE_STALE'
          ? 'AUTO_SOURCE_LOST'
          : 'AUTO_INTERNAL_ERROR',
      )
      return
    }
    if (event.type === 'stopped') {
      z.object({}).strict().parse(event.payload)
      if (!owned.stopping || envelope.binary.byteLength !== 0) {
        throw new Error('Unexpected stopped event')
      }
      return
    }
    if (event.type.startsWith('analysis_')) {
      if (owned.stopping) return
      this.handleAnalysisEvent(owned, event.type, event.payload, envelope.binary)
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
    if (
      payload.game.rect !== null &&
      (payload.game.rect.x + payload.game.rect.width > payload.width ||
        payload.game.rect.y + payload.game.rect.height > payload.height)
    ) {
      throw new Error('Prepared game rectangle exceeds the frozen frame')
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
      game: payload.game,
    })
  }

  private handleAnalysisEvent(
    owned: OwnedProcess,
    type: string,
    payload: Record<string, unknown>,
    binary: Buffer,
  ): void {
    if (!owned.ready || owned.stopping || owned.resolveFreeze !== null) {
      throw new Error('Analysis event arrived out of order')
    }
    if (type === 'analysis_cancelled') {
      z.object({}).strict().parse(payload)
      if (binary.byteLength !== 0 || owned.cancellation === null) {
        throw new Error('Unexpected analysis cancellation acknowledgement')
      }
      const cancellation = owned.cancellation
      owned.cancellation = null
      clearTimeout(cancellation.timer)
      cancellation.resolve()
      return
    }
    if (owned.analysis === null && owned.cancellation === null) {
      throw new Error('Analysis event without active analysis')
    }
    if (type === 'analysis_progress') {
      const progress = AnalysisProgressSchema.parse(payload)
      if (binary.byteLength !== 0) throw new Error('Progress has binary data')
      const analysis = owned.analysis
      if (analysis !== null) {
        if (
          progress.elapsedMs < analysis.elapsedMs ||
          progress.framesAnalyzed < analysis.framesAnalyzed
        ) {
          throw new Error('Analysis progress moved backwards')
        }
        analysis.elapsedMs = progress.elapsedMs
        analysis.framesAnalyzed = progress.framesAnalyzed
        analysis.onProgress(progress)
      }
      return
    }
    if (type === 'analysis_preview') {
      const preview = DetectionPreviewSchema.parse({
        ...PreviewPayloadSchema.parse(payload),
        bytes: binary,
      })
      const dimensions = jpegDimensions(binary)
      if (dimensions?.width !== preview.width || dimensions.height !== preview.height) {
        throw new Error('Analysis JPEG dimensions are invalid')
      }
      owned.analysis?.onPreview(preview)
      return
    }
    const result = AnalysisResultSchema.parse(payload)
    let frame: CapturedFrame | null = null
    if (result.ok || binary.byteLength > 0) {
      const dimensions = pngDimensions(binary)
      if (
        binary.byteLength === 0 ||
        binary.byteLength > MAX_PNG_BYTES ||
        dimensions?.width !== result.frameWidth ||
        dimensions?.height !== result.frameHeight ||
        result.frameWidth === undefined ||
        result.frameHeight === undefined
      )
        throw new Error('Analysis PNG dimensions are invalid')
      frame = {
        size: { width: result.frameWidth, height: result.frameHeight },
        png: binary,
        ...(result.game ? { game: { ...result.game, frames: 8 } } : {}),
      }
      owned.size = frame.size
    }
    // The acknowledgement fences retries: discard all analysis events preceding it.
    if (owned.cancellation !== null) return
    if (!result.ok && result.code === 'AUTO_SOURCE_LOST') void this.kill(owned)
    this.finishAnalysis(owned, result, frame)
  }

  private finishAnalysis(
    owned: OwnedProcess,
    result: AnalysisResult,
    frame: CapturedFrame | null = null,
  ): void {
    const analysis = owned.analysis
    if (analysis === null) return
    owned.analysis = null
    clearTimeout(analysis.timer)
    analysis.detachAbort()
    analysis.resolve({ result, frame })
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
    this.finishAnalysis(owned, { ok: false, code: 'AUTO_INTERNAL_ERROR' })
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

  private fail(
    owned: OwnedProcess,
    code: string,
    cause: Error,
    analysisCode: AutoSetupCode = 'AUTO_INTERNAL_ERROR',
  ): void {
    if (!this.current(owned)) return
    const error = new ApplicationError(code, 'The selected source capture failed', {
      cause,
    })
    this.finishAnalysis(owned, { ok: false, code: analysisCode })
    this.rejectPending(owned, error)
    void this.kill(owned)
  }

  private rejectPending(owned: OwnedProcess, error: Error): void {
    if (!owned.ready) owned.rejectReady(error)
    this.finishAnalysis(owned, { ok: false, code: 'AUTO_INTERNAL_ERROR' })
    if (owned.cancellation !== null) {
      const cancellation = owned.cancellation
      owned.cancellation = null
      clearTimeout(cancellation.timer)
      cancellation.reject(error)
    }
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
    if (owned.analysis !== null) clearTimeout(owned.analysis.timer)
    if (owned.cancellation !== null) clearTimeout(owned.cancellation.timer)
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
