import WebSocket from 'ws'
import { z } from 'zod'

import {
  RealtimeStatusSchema,
  type RealtimeState,
  type RealtimeStatus,
} from '../../../shared/models/network'

const ConnectionAckSchema = z
  .object({ type: z.literal('connection'), status: z.literal('connected') })
  .loose()
const PongSchema = z.object({ type: z.literal('pong') }).loose()
const AuthFailureSchema = z
  .object({
    type: z.enum(['auth_error', 'error']),
    status: z.union([z.literal(401), z.literal(403)]).optional(),
    code: z
      .union([
        z.literal(401),
        z.literal(403),
        z.literal('unauthorized'),
        z.literal('forbidden'),
      ])
      .optional(),
  })
  .loose()

const MAX_EVENT_DEPTH = 8
const MAX_EVENT_NODES = 512
const MAX_OBJECT_KEYS = 64
const MAX_ARRAY_ITEMS = 64
const MAX_EVENT_STRING_LENGTH = 2_048

export type ReprocessedEventData = Record<string, unknown>

function isBoundedEventObject(value: unknown): value is ReprocessedEventData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  let nodes = 0
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > MAX_EVENT_NODES || depth > MAX_EVENT_DEPTH) return false
    if (
      current === null ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      return true
    }
    if (typeof current === 'string') return current.length <= MAX_EVENT_STRING_LENGTH
    if (Array.isArray(current)) {
      return (
        current.length <= MAX_ARRAY_ITEMS &&
        current.every((item) => visit(item, depth + 1))
      )
    }
    if (typeof current !== 'object') return false
    const object = current as Record<string, unknown>
    const prototype = Reflect.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) return false
    const entries = Object.entries(object)
    return (
      entries.length <= MAX_OBJECT_KEYS &&
      entries.every(
        ([key, item]) =>
          key.length > 0 &&
          key.length <= 160 &&
          !['__proto__', 'constructor', 'prototype'].includes(key) &&
          visit(item, depth + 1),
      )
    )
  }
  return visit(value, 0)
}

const ReprocessedEventSchema = z
  .object({
    type: z.literal('ocr_reprocessed'),
    data: z.custom<ReprocessedEventData>(isBoundedEventObject),
  })
  .strict()

export interface WebSocketLike {
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number) => void): void
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface WebSocketTimerFactory {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
  setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>
  clearInterval: (timer: ReturnType<typeof setInterval>) => void
}

export interface WebSocketTokenSource {
  getAccessToken: (forceRefresh?: boolean) => Promise<string | null>
}

export interface WebSocketLogger {
  debug: (message: string, context?: unknown) => void
  warn: (message: string, context?: unknown) => void
}

const nodeTimers: WebSocketTimerFactory = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (timer) => clearInterval(timer),
}

export const nodeWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url, { maxPayload: 64 * 1024 })

function messageText(data: unknown): string | null {
  if (typeof data === 'string') return data.length <= 64 * 1024 ? data : null
  if (Buffer.isBuffer(data))
    return data.byteLength <= 64 * 1024 ? data.toString('utf8') : null
  if (data instanceof ArrayBuffer) {
    return data.byteLength <= 64 * 1024 ? Buffer.from(data).toString('utf8') : null
  }
  return null
}

export class WebSocketSession {
  #state: RealtimeState = 'DISCONNECTED'
  #desiredConnected = false
  #generation = 0
  #socket: WebSocketLike | undefined
  #reconnectAttempt = 0
  #unknownEventCount = 0
  #authRefreshUsed = false
  #connectTimer: ReturnType<typeof setTimeout> | undefined
  #authTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined
  #pongTimer: ReturnType<typeof setTimeout> | undefined
  readonly #listeners = new Set<(status: RealtimeStatus) => void>()
  readonly #reprocessedListeners = new Set<
    (data: ReprocessedEventData) => void | Promise<void>
  >()

  constructor(
    private readonly url: string,
    private readonly tokens: WebSocketTokenSource,
    private readonly logger: WebSocketLogger,
    private readonly socketFactory: WebSocketFactory = nodeWebSocketFactory,
    private readonly timers: WebSocketTimerFactory = nodeTimers,
    private readonly random: () => number = Math.random,
  ) {}

  getStatus(): RealtimeStatus {
    return RealtimeStatusSchema.parse({
      state: this.#state,
      desiredConnected: this.#desiredConnected,
      reconnectAttempt: this.#reconnectAttempt,
      unknownEventCount: this.#unknownEventCount,
    })
  }

  subscribe(listener: (status: RealtimeStatus) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  subscribeReprocessed(
    listener: (data: ReprocessedEventData) => void | Promise<void>,
  ): () => void {
    this.#reprocessedListeners.add(listener)
    return () => this.#reprocessedListeners.delete(listener)
  }

  start(): void {
    if (this.#desiredConnected) return
    this.#desiredConnected = true
    this.#authRefreshUsed = false
    void this.connect(false)
  }

  stop(): void {
    this.#desiredConnected = false
    ++this.#generation
    this.clearTimers()
    const socket = this.#socket
    this.#socket = undefined
    socket?.close(1000, 'client stop')
    this.#reconnectAttempt = 0
    this.setState('DISCONNECTED')
  }

  private async connect(forceRefresh: boolean): Promise<void> {
    if (!this.#desiredConnected) return
    const generation = ++this.#generation
    this.clearConnectionTimers()
    this.setState('CONNECTING')
    const token = await this.tokens.getAccessToken(forceRefresh)
    if (!this.isCurrent(generation)) return
    if (token === null) {
      this.scheduleReconnect(generation)
      return
    }

    let socket: WebSocketLike
    try {
      socket = this.socketFactory(this.url)
    } catch (error) {
      this.logger.warn('WebSocket construction failed', { error })
      this.scheduleReconnect(generation)
      return
    }
    this.#socket = socket
    this.#connectTimer = this.timers.setTimeout(() => {
      if (!this.isSocketCurrent(generation, socket) || this.#state !== 'CONNECTING')
        return
      this.logger.warn('WebSocket transport timed out')
      socket.close(4000, 'transport timeout')
    }, 10_000)
    socket.on('open', () => {
      if (!this.isSocketCurrent(generation, socket)) return
      if (this.#connectTimer !== undefined) this.timers.clearTimeout(this.#connectTimer)
      this.#connectTimer = undefined
      this.setState('AUTHENTICATING')
      try {
        socket.send(JSON.stringify({ type: 'auth', token }))
      } catch (error) {
        this.logger.warn('WebSocket authentication send failed', { error })
        socket.close(4000, 'authentication send failed')
        return
      }
      this.#authTimer = this.timers.setTimeout(() => {
        if (!this.isSocketCurrent(generation, socket) || this.#state !== 'AUTHENTICATING')
          return
        this.logger.warn('WebSocket authentication timed out')
        socket.close(4000, 'authentication timeout')
      }, 10_000)
    })
    socket.on('message', (data) => this.handleMessage(generation, socket, data))
    socket.on('error', (error) => {
      if (this.isSocketCurrent(generation, socket)) {
        this.logger.warn('WebSocket transport error', { message: error.message })
      }
    })
    socket.on('close', (code) => {
      if (!this.isSocketCurrent(generation, socket)) return
      this.#socket = undefined
      this.clearConnectionTimers()
      if (!this.#desiredConnected) {
        this.setState('DISCONNECTED')
        return
      }
      if ((code === 1008 || code === 4001 || code === 4003) && !this.#authRefreshUsed) {
        this.#authRefreshUsed = true
        void this.connect(true)
      } else {
        this.scheduleReconnect(generation)
      }
    })
  }

  private handleMessage(generation: number, socket: WebSocketLike, data: unknown): void {
    if (!this.isSocketCurrent(generation, socket)) return
    const text = messageText(data)
    if (text === null) {
      this.recordUnknown('oversized or unsupported')
      return
    }
    let message: unknown
    try {
      message = JSON.parse(text) as unknown
    } catch {
      this.recordUnknown('invalid JSON')
      return
    }

    if (PongSchema.safeParse(message).success) {
      if (this.#pongTimer !== undefined) this.timers.clearTimeout(this.#pongTimer)
      this.#pongTimer = undefined
      return
    }
    if (ConnectionAckSchema.safeParse(message).success) {
      if (this.#state !== 'AUTHENTICATING') return
      if (this.#authTimer !== undefined) this.timers.clearTimeout(this.#authTimer)
      this.#authTimer = undefined
      this.#reconnectAttempt = 0
      this.#authRefreshUsed = false
      this.setState('READY')
      this.startHeartbeat(generation, socket)
      return
    }
    if (
      AuthFailureSchema.safeParse(message).success &&
      this.#state === 'AUTHENTICATING'
    ) {
      socket.close(4001, 'authentication rejected')
      return
    }
    const reprocessed = ReprocessedEventSchema.safeParse(message)
    if (reprocessed.success && this.#state === 'READY') {
      this.emitReprocessed(reprocessed.data.data)
      return
    }
    this.recordUnknown('unhandled event')
  }

  private startHeartbeat(generation: number, socket: WebSocketLike): void {
    this.#heartbeatTimer = this.timers.setInterval(() => {
      if (!this.isSocketCurrent(generation, socket) || this.#state !== 'READY') return
      try {
        socket.send(JSON.stringify({ type: 'ping' }))
      } catch (error) {
        this.logger.warn('WebSocket heartbeat send failed', { error })
        socket.close(4000, 'heartbeat send failed')
        return
      }
      if (this.#pongTimer !== undefined) this.timers.clearTimeout(this.#pongTimer)
      this.#pongTimer = this.timers.setTimeout(() => {
        if (this.isSocketCurrent(generation, socket)) socket.close(4000, 'pong timeout')
      }, 20_000)
    }, 60_000)
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrent(generation) || !this.#desiredConnected) return
    this.#reconnectAttempt += 1
    this.setState('BACKOFF')
    const cap = Math.min(30_000, 1_000 * 2 ** Math.min(this.#reconnectAttempt - 1, 10))
    const delay = Math.floor(this.random() * cap)
    this.#reconnectTimer = this.timers.setTimeout(() => {
      if (this.isCurrent(generation) && this.#desiredConnected) void this.connect(false)
    }, delay)
  }

  private recordUnknown(reason: string): void {
    this.#unknownEventCount = Math.min(100, this.#unknownEventCount + 1)
    this.logger.debug('Ignored WebSocket event', {
      reason,
      count: this.#unknownEventCount,
    })
    this.emitStatus()
  }

  private isCurrent(generation: number): boolean {
    return generation === this.#generation
  }

  private isSocketCurrent(generation: number, socket: WebSocketLike): boolean {
    return this.isCurrent(generation) && this.#socket === socket
  }

  private setState(state: RealtimeState): void {
    this.#state = state
    this.emitStatus()
  }

  private emitStatus(): void {
    const status = this.getStatus()
    for (const listener of this.#listeners) {
      try {
        listener(status)
      } catch {
        this.logger.warn('WebSocket status listener failed')
      }
    }
  }

  private emitReprocessed(data: ReprocessedEventData): void {
    for (const listener of this.#reprocessedListeners) {
      try {
        void Promise.resolve(listener(structuredClone(data))).catch(() =>
          this.logger.warn('WebSocket reprocessed listener failed'),
        )
      } catch {
        this.logger.warn('WebSocket reprocessed listener failed')
      }
    }
  }

  private clearConnectionTimers(): void {
    if (this.#connectTimer !== undefined) this.timers.clearTimeout(this.#connectTimer)
    if (this.#authTimer !== undefined) this.timers.clearTimeout(this.#authTimer)
    if (this.#heartbeatTimer !== undefined)
      this.timers.clearInterval(this.#heartbeatTimer)
    if (this.#pongTimer !== undefined) this.timers.clearTimeout(this.#pongTimer)
    this.#connectTimer = undefined
    this.#authTimer = undefined
    this.#heartbeatTimer = undefined
    this.#pongTimer = undefined
  }

  private clearTimers(): void {
    this.clearConnectionTimers()
    if (this.#reconnectTimer !== undefined) this.timers.clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
  }
}
