import {
  H2HRequestSchema,
  H2HHttpResponseSchema,
  type H2HRequest,
  type ParsedH2HRequest,
  type H2HLookupResult,
} from '../../../shared/contracts/h2h'
import type { AuthSession } from './auth-session'
import type { AuthenticatedApiClient } from './api-client'

const MAX_ISO_RETRY_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

type Outcome =
  | Omit<Extract<H2HLookupResult, { capability: 'supported' }>, 'requestId'>
  | Omit<Exclude<H2HLookupResult, { capability: 'supported' }>, 'requestId'>
interface Flight {
  controller: AbortController
  consumers: Set<string>
  promise: Promise<Outcome>
}
export class H2HService {
  readonly #flights = new Map<string, Flight>()
  readonly #requests = new Map<string, { flight: Flight; cancel: () => void }>()
  #retryAt = 0
  #retryAtIso: string | null = null
  #retryGeneration = -1
  constructor(
    private readonly api: AuthenticatedApiClient,
    private readonly auth: AuthSession,
    private readonly now: () => number = Date.now,
  ) {}
  async lookup(raw: H2HRequest): Promise<H2HLookupResult> {
    const payload = H2HRequestSchema.parse(raw)
    const generation = this.auth.getContextGeneration()
    this.cancel(payload.requestId)
    if (this.#retryGeneration === generation && this.#retryAt > this.now())
      return {
        capability: 'rate_limited',
        requestId: payload.requestId,
        retryAt: this.#retryAtIso,
        code: 'H2H_RATE_LIMITED',
      }
    if (this.#requests.size >= 32)
      return {
        capability: 'unavailable',
        requestId: payload.requestId,
        retryAt: null,
        code: 'H2H_REQUEST_FAILED',
      }
    const key = `${generation}:${payload.opponentTag}:${payload.recentLimit}`
    let flight = this.#flights.get(key)
    if (flight === undefined) {
      const controller = new AbortController()
      flight = {
        controller,
        consumers: new Set(),
        promise: this.fetch(payload, generation, controller.signal),
      }
      this.#flights.set(key, flight)
      const owned = flight
      void flight.promise.finally(() => {
        if (this.#flights.get(key) === owned) this.#flights.delete(key)
      })
    }
    const owned = flight
    owned.consumers.add(payload.requestId)
    const cancellation = Promise.withResolvers<Outcome>()
    const request = {
      flight: owned,
      cancel: () =>
        cancellation.resolve({
          capability: 'cancelled',
          retryAt: null,
          code: 'H2H_CANCELLED',
        }),
    }
    this.#requests.set(payload.requestId, request)
    try {
      const result = await Promise.race([owned.promise, cancellation.promise])
      if (generation !== this.auth.getContextGeneration())
        return {
          capability: 'cancelled',
          requestId: payload.requestId,
          retryAt: null,
          code: 'H2H_CANCELLED',
        }
      return { ...result, requestId: payload.requestId }
    } finally {
      if (this.#requests.get(payload.requestId) === request) {
        this.#requests.delete(payload.requestId)
        owned.consumers.delete(payload.requestId)
      }
    }
  }
  cancel(requestId: string): void {
    const request = this.#requests.get(requestId)
    if (request === undefined) return
    this.#requests.delete(requestId)
    request.cancel()
    request.flight.consumers.delete(requestId)
    if (request.flight.consumers.size === 0) {
      request.flight.controller.abort()
      for (const [key, flight] of this.#flights)
        if (flight === request.flight) this.#flights.delete(key)
    }
  }
  cancelAll(): void {
    for (const id of this.#requests.keys()) this.cancel(id)
  }
  private async fetch(
    payload: ParsedH2HRequest,
    generation: number,
    signal: AbortSignal,
  ): Promise<Outcome> {
    try {
      const response = await this.api.request({
        method: 'GET',
        path: '/api/user/me/h2h',
        query: { opponent_tag: payload.opponentTag, recent_limit: payload.recentLimit },
        schema: H2HHttpResponseSchema,
        timeoutMs: 10_000,
        signal,
        authContextGuard: () => generation === this.auth.getContextGeneration(),
      })
      if (signal.aborted || generation !== this.auth.getContextGeneration())
        return { capability: 'cancelled', retryAt: null, code: 'H2H_CANCELLED' }
      if (response.ok)
        return {
          capability: 'supported',
          data: H2HHttpResponseSchema.parse(response.data),
        }
      if (response.error.status === 404)
        return { capability: 'unsupported', retryAt: null, code: 'H2H_UNSUPPORTED' }
      if (response.error.status === 429) {
        this.#retryAt = Math.max(
          this.#retryGeneration === generation ? this.#retryAt : 0,
          this.now() + (response.error.retryAfterSeconds ?? 1) * 1000,
        )
        this.#retryAtIso =
          this.#retryAt <= MAX_ISO_RETRY_AT ? new Date(this.#retryAt).toISOString() : null
        this.#retryGeneration = generation
        return {
          capability: 'rate_limited',
          retryAt: this.#retryAtIso,
          code: 'H2H_RATE_LIMITED',
        }
      }
      return {
        capability: 'unavailable',
        retryAt: null,
        code:
          response.error.code === 'UNAUTHORIZED' || response.error.code === 'FORBIDDEN'
            ? response.error.code
            : 'H2H_REQUEST_FAILED',
      }
    } catch {
      return { capability: 'unavailable', retryAt: null, code: 'H2H_REQUEST_FAILED' }
    }
  }
}
