import { randomUUID } from 'node:crypto'

import { ApplicationError } from '../../../shared/errors/application-error'
import type { ResolvedCaptureSource } from '../domain/capture-source'
import type { CapturedFrame } from './capture-service'
import type { CaptureSourceRegistry } from './capture-source-registry'
import type { PreparedCaptureProcessService } from './prepared-capture-process-service'

export interface CapturePreparationView {
  preparationId: string
  sourceKey: string
  revision: string
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
  #generation = 0
  #transition: Promise<void> = Promise.resolve()

  constructor(
    private readonly registry: CaptureSourceRegistry,
    private readonly process: PreparedCaptureProcessService,
  ) {}

  prepare(sourceKey: string, revision: string): Promise<CapturePreparationView> {
    const desired = { generation: ++this.#generation, sourceKey, revision }
    this.#desired = desired
    return this.queue(async () => {
      await this.stopPrepared()
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
    return this.queue(async () => {
      await this.stopPrepared()
      return true
    })
  }

  stop(): Promise<void> {
    this.#desired = null
    ++this.#generation
    return this.queue(() => this.stopPrepared())
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
