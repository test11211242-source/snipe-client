import { randomUUID } from 'node:crypto'

import type {
  AnalysisProgress,
  AnalysisResult,
  DetectionPreview,
} from '../../../shared/contracts/auto-setup'
import { ApplicationError } from '../../../shared/errors/application-error'
import type { PixelSize } from '../../../shared/models/capture'
import type { ResolvedCaptureSource } from '../domain/capture-source'
import type { CapturedFrame } from './capture-service'
import type { CaptureSourceRegistry } from './capture-source-registry'
import type { PreparedCaptureProcessService } from './prepared-capture-process-service'

export interface CapturePreparationView {
  preparationId: string
  sourceKey: string
  revision: string
}

export interface LivePreparedCapture {
  analyze(
    onProgress: (progress: AnalysisProgress) => void,
    onPreview: (preview: DetectionPreview) => void,
    signal?: AbortSignal,
  ): Promise<{ result: AnalysisResult; frame: CapturedFrame | null }>
  cancelAnalysis(): Promise<void>
  freeze(signal?: AbortSignal): Promise<CapturedFrame>
  stop(): Promise<void>
  isAlive(): boolean
  getSize(): PixelSize | null
}

interface PreparedSource extends CapturePreparationView {
  sessionId: string
  source: ResolvedCaptureSource
}

interface DesiredSource {
  generation: number
  sourceKey: string
  revision: string
}

export class CapturePreparationService {
  #prepared: PreparedSource | null = null
  #desired: DesiredSource | null = null
  #liveSessionId: string | null = null
  #generation = 0
  #transition: Promise<void> = Promise.resolve()

  constructor(
    private readonly registry: CaptureSourceRegistry,
    private readonly process: PreparedCaptureProcessService,
  ) {}

  prepare(sourceKey: string, revision: string): Promise<CapturePreparationView> {
    if (this.#liveSessionId !== null && this.process.isAlive(this.#liveSessionId)) {
      return Promise.reject(
        new ApplicationError(
          'CAPTURE_PREPARATION_OWNED',
          'Capture is owned by an active setup',
        ),
      )
    }
    this.#liveSessionId = null
    const desired = { generation: ++this.#generation, sourceKey, revision }
    this.#desired = desired
    // Readiness can block the transition queue, so interrupt the old worker now.
    const stopped = this.stopPrepared()
    return this.queue(async () => {
      await stopped
      this.assertDesired(desired)
      const source = await this.registry.resolve(sourceKey, revision)
      this.assertDesired(desired)
      const started = await this.process.start(source.selector)
      if (!this.isDesired(desired)) {
        await this.process.stop()
        throw this.cancelled()
      }
      const prepared: PreparedSource = {
        preparationId: randomUUID(),
        sourceKey,
        revision,
        sessionId: started.sessionId,
        source,
      }
      this.#prepared = prepared
      return {
        preparationId: prepared.preparationId,
        sourceKey,
        revision,
      }
    })
  }

  takeLive(
    preparationId: string,
  ): Promise<{ source: ResolvedCaptureSource; capture: LivePreparedCapture }> {
    const prepared = this.#prepared
    if (
      prepared?.preparationId !== preparationId ||
      !this.process.isAlive(prepared.sessionId)
    ) {
      return Promise.reject(
        new ApplicationError(
          'CAPTURE_PREPARATION_STALE',
          'The selected source is no longer prepared',
        ),
      )
    }
    this.#prepared = null
    this.#desired = null
    ++this.#generation
    this.#liveSessionId = prepared.sessionId
    let consumed = false
    const assertOwned = (): void => {
      if (consumed || this.#liveSessionId !== prepared.sessionId) {
        throw new ApplicationError(
          'CAPTURE_PREPARATION_STALE',
          'Capture is no longer available',
        )
      }
    }
    const relinquish = (): void => {
      consumed = true
      if (this.#liveSessionId === prepared.sessionId) this.#liveSessionId = null
    }
    const capture: LivePreparedCapture = {
      analyze: (onProgress, onPreview, signal) => {
        assertOwned()
        return this.process.analyze(prepared.sessionId, onProgress, onPreview, signal)
      },
      cancelAnalysis: () => {
        if (consumed || this.#liveSessionId !== prepared.sessionId)
          return Promise.resolve()
        return this.process.cancelAnalysis(prepared.sessionId)
      },
      freeze: async (signal) => {
        assertOwned()
        await this.process.cancelAnalysis(prepared.sessionId)
        assertOwned()
        try {
          return await this.process.freeze(prepared.sessionId, signal)
        } finally {
          relinquish()
        }
      },
      stop: async () => {
        if (consumed || this.#liveSessionId !== prepared.sessionId) return
        // Keep ownership until the old process has closed, blocking a new preparation.
        consumed = true
        try {
          await this.process.stop(prepared.sessionId)
        } finally {
          relinquish()
        }
      },
      isAlive: () =>
        !consumed &&
        this.#liveSessionId === prepared.sessionId &&
        this.process.isAlive(prepared.sessionId),
      getSize: () =>
        !consumed && this.#liveSessionId === prepared.sessionId
          ? this.process.getSize(prepared.sessionId)
          : null,
    }
    return Promise.resolve({ source: prepared.source, capture })
  }

  async freeze(
    preparationId: string,
    signal?: AbortSignal,
  ): Promise<{ source: ResolvedCaptureSource; frame: CapturedFrame }> {
    if (this.#prepared?.preparationId !== preparationId) {
      throw new ApplicationError(
        'CAPTURE_PREPARATION_STALE',
        'The selected source is no longer prepared',
      )
    }
    const prepared = this.#prepared
    this.#prepared = null
    this.#desired = null
    ++this.#generation
    const frame = await this.process.freeze(prepared.sessionId, signal)
    return { source: prepared.source, frame }
  }

  release(sourceKey: string, revision: string): Promise<boolean> {
    const desired = this.#desired
    if (desired?.sourceKey !== sourceKey || desired.revision !== revision) {
      return Promise.resolve(false)
    }
    this.#desired = null
    ++this.#generation
    const stopped = this.stopPrepared()
    return this.queue(async () => {
      await stopped
      return true
    })
  }

  stop(): Promise<void> {
    this.#desired = null
    ++this.#generation
    const stopped = this.stopPrepared()
    return this.queue(() => stopped)
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transition.then(operation, operation)
    this.#transition = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async stopPrepared(): Promise<void> {
    if (this.#liveSessionId !== null) return
    this.#prepared = null
    await this.process.stop()
  }

  private assertDesired(desired: DesiredSource): void {
    if (!this.isDesired(desired)) throw this.cancelled()
  }

  private isDesired(desired: DesiredSource): boolean {
    return (
      this.#desired?.generation === desired.generation &&
      this.#desired.sourceKey === desired.sourceKey &&
      this.#desired.revision === desired.revision
    )
  }

  private cancelled(): ApplicationError {
    return new ApplicationError(
      'CAPTURE_PREPARATION_CANCELLED',
      'Capture preparation was replaced by another source',
    )
  }
}
