import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  ApplicationError,
  PublicErrorSchema,
} from '../../../shared/errors/application-error'
import {
  PixelSizeSchema,
  TriggerProfileSchema,
  type NormalizedRect,
  type PixelSize,
  type TriggerProfile,
} from '../../../shared/models/capture'
import type { SetupCaptureSelector } from '../domain/capture-source'
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from './binary-protocol'
import type { PythonWorkerService } from './python-worker-service'

const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_PIXELS = 20_000_000

const CaptureResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.uuid(),
      ok: z.literal(true),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      mimeType: z.literal('image/png'),
      byteLength: z.number().int().positive().max(MAX_PNG_BYTES),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1),
      ok: z.literal(false),
      error: PublicErrorSchema,
    })
    .strict(),
])

const AnalysisResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.uuid(),
      ok: z.literal(true),
      profile: TriggerProfileSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1),
      ok: z.literal(false),
      error: PublicErrorSchema,
    })
    .strict(),
])

export interface CapturedFrame {
  size: PixelSize
  png: Buffer
}

function toWorkerSelector(selector: SetupCaptureSelector): unknown {
  return selector.kind === 'window'
    ? { kind: 'window', windowHwnd: selector.windowHwnd }
    : {
        kind: 'display',
        displayDeviceName: selector.displayDeviceName,
        electronDisplayId: selector.electronDisplayId,
      }
}

export function normalizedToPixelRect(rect: NormalizedRect, size: PixelSize) {
  const x = Math.round(rect.x * size.width)
  const y = Math.round(rect.y * size.height)
  const right = Math.round((rect.x + rect.width) * size.width)
  const bottom = Math.round((rect.y + rect.height) * size.height)
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  }
}

export class CaptureService {
  constructor(
    private readonly worker: PythonWorkerService,
    private readonly pythonExecutable: string,
    private readonly captureScriptPath: string,
    private readonly analyzeScriptPath: string,
  ) {}

  async capture(
    selector: SetupCaptureSelector,
    signal?: AbortSignal,
  ): Promise<CapturedFrame> {
    const requestId = randomUUID()
    const result = await this.worker.execute({
      requestId,
      executable: this.pythonExecutable,
      scriptPath: this.captureScriptPath,
      input: encodeBinaryEnvelope({
        protocolVersion: 1,
        requestId,
        operation: 'capture_once',
        selector: toWorkerSelector(selector),
      }),
      timeoutMs: 15_000,
      ...(signal === undefined ? {} : { signal }),
    })
    const envelope = decodeBinaryEnvelope(result.stdout, {
      maxMetadataBytes: 64 * 1024,
      maxBinaryBytes: MAX_PNG_BYTES,
    })
    const metadata = CaptureResultSchema.parse(envelope.metadata)
    if (metadata.requestId !== result.requestId) {
      throw new ApplicationError('WORKER_RESULT_STALE', 'Capture worker result is stale')
    }
    if (!metadata.ok)
      throw new ApplicationError(metadata.error.code, metadata.error.message)
    const size = PixelSizeSchema.parse({ width: metadata.width, height: metadata.height })
    if (size.width * size.height > MAX_PIXELS) {
      throw new ApplicationError(
        'CAPTURE_FRAME_TOO_LARGE',
        'Captured frame exceeds pixel limit',
      )
    }
    if (
      envelope.binary.byteLength !== metadata.byteLength ||
      !envelope.binary.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))
    ) {
      throw new ApplicationError(
        'CAPTURE_PNG_INVALID',
        'Capture worker returned invalid PNG',
      )
    }
    return { size, png: envelope.binary }
  }

  async analyze(
    frame: CapturedFrame,
    triggerRect: NormalizedRect,
    signal?: AbortSignal,
  ): Promise<TriggerProfile> {
    const requestId = randomUUID()
    const result = await this.worker.execute({
      requestId,
      executable: this.pythonExecutable,
      scriptPath: this.analyzeScriptPath,
      input: encodeBinaryEnvelope(
        {
          protocolVersion: 1,
          requestId,
          operation: 'analyze_trigger',
          outerRect: normalizedToPixelRect(triggerRect, frame.size),
        },
        frame.png,
      ),
      timeoutMs: 12_000,
      ...(signal === undefined ? {} : { signal }),
    })
    const envelope = decodeBinaryEnvelope(result.stdout, {
      maxMetadataBytes: 128 * 1024,
      maxBinaryBytes: 0,
    })
    const metadata = AnalysisResultSchema.parse(envelope.metadata)
    if (metadata.requestId !== result.requestId) {
      throw new ApplicationError('WORKER_RESULT_STALE', 'Analyzer result is stale')
    }
    if (!metadata.ok)
      throw new ApplicationError(metadata.error.code, metadata.error.message)
    return metadata.profile
  }
}
