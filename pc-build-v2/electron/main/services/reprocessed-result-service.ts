import type { AuthSession } from './auth-session'
import type { MonitorSupervisor } from './monitor-supervisor'
import { normalizeOcrResponse } from './ocr-api-client'
import type { ReprocessedEventData, WebSocketSession } from './websocket-session'

export class ReprocessedResultService {
  #generation = 0
  #userId: string | null = null
  #disposeRealtime: (() => void) | null = null

  constructor(
    private readonly realtime: Pick<WebSocketSession, 'subscribeReprocessed'>,
    private readonly auth: Pick<AuthSession, 'getView'>,
    private readonly monitor: Pick<
      MonitorSupervisor,
      'getPreferences' | 'addExternalResult'
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(userId: string): void {
    if (this.#userId === userId && this.#disposeRealtime !== null) return
    this.stop()
    const generation = ++this.#generation
    this.#userId = userId
    this.#disposeRealtime = this.realtime.subscribeReprocessed((data) =>
      this.accept(generation, userId, data),
    )
  }

  stop(): void {
    ++this.#generation
    this.#disposeRealtime?.()
    this.#disposeRealtime = null
    this.#userId = null
  }

  private async accept(
    generation: number,
    userId: string,
    data: ReprocessedEventData,
  ): Promise<void> {
    if (!this.isCurrent(generation, userId)) return
    const timestamp = this.now().toISOString()
    const preferences = await this.monitor.getPreferences()
    if (!this.isCurrent(generation, userId)) return
    const result = normalizeOcrResponse(data, { timestamp, ...preferences })
    if (!this.isCurrent(generation, userId)) return
    this.monitor.addExternalResult(result)
  }

  private isCurrent(generation: number, userId: string): boolean {
    return (
      generation === this.#generation &&
      this.#userId === userId &&
      this.auth.getView().user?.id === userId
    )
  }
}
