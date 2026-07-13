import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WebSocketSession,
  type WebSocketLike,
  type WebSocketTimerFactory,
} from './websocket-session'

type Listener = (...args: never[]) => void

class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, Listener[]>()
  readonly sent: string[] = []
  readonly close = vi.fn<(code?: number, reason?: string) => void>()

  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: string, listener: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]))
  }
}

const timers: WebSocketTimerFactory = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (timer) => clearInterval(timer),
}
const logger = { debug: vi.fn(), warn: vi.fn() }

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function socketAt(sockets: readonly FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index]
  if (socket === undefined) throw new Error(`Socket ${index} was not created`)
  return socket
}

describe('WebSocketSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => vi.useRealTimers())

  it('becomes READY only after the validated ack and ignores stale sockets', async () => {
    const sockets: FakeSocket[] = []
    const session = new WebSocketSession(
      'wss://api.artcsworld.xyz/ws',
      { getAccessToken: () => Promise.resolve('token') },
      logger,
      () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      timers,
      () => 0,
    )
    session.start()
    await flush()
    socketAt(sockets, 0).emit('open')
    expect(session.getStatus().state).toBe('AUTHENTICATING')
    expect(socketAt(sockets, 0).sent).toEqual([
      JSON.stringify({ type: 'auth', token: 'token' }),
    ])
    socketAt(sockets, 0).emit(
      'message',
      JSON.stringify({ type: 'connection', status: 'connected' }),
    )
    expect(session.getStatus().state).toBe('READY')

    socketAt(sockets, 0).emit('close', 1006)
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(sockets).toHaveLength(2)
    socketAt(sockets, 0).emit(
      'message',
      JSON.stringify({ type: 'connection', status: 'connected' }),
    )
    expect(session.getStatus().state).toBe('CONNECTING')
  })

  it('closes its socket on auth and pong timeouts and emits JSON heartbeat', async () => {
    const socket = new FakeSocket()
    const session = new WebSocketSession(
      'wss://api.artcsworld.xyz/ws',
      { getAccessToken: () => Promise.resolve('token') },
      logger,
      () => socket,
      timers,
    )
    session.start()
    await flush()
    socket.emit('open')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.close).toHaveBeenCalledWith(4000, 'authentication timeout')

    socket.emit('message', JSON.stringify({ type: 'connection', status: 'connected' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(socket.sent).toContain(JSON.stringify({ type: 'ping' }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(socket.close).toHaveBeenCalledWith(4000, 'pong timeout')
  })

  it('closes a transport that never opens', async () => {
    const socket = new FakeSocket()
    const session = new WebSocketSession(
      'wss://api.artcsworld.xyz/ws',
      { getAccessToken: () => Promise.resolve('token') },
      logger,
      () => socket,
      timers,
    )

    session.start()
    await flush()
    expect(session.getStatus().state).toBe('CONNECTING')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.close).toHaveBeenCalledWith(4000, 'transport timeout')
  })

  it('stops explicitly without reconnect and refreshes once after auth failure', async () => {
    const sockets: FakeSocket[] = []
    const getAccessToken = vi
      .fn<(force?: boolean) => Promise<string | null>>()
      .mockResolvedValue('token')
    const session = new WebSocketSession(
      'wss://api.artcsworld.xyz/ws',
      { getAccessToken },
      logger,
      () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      timers,
      () => 0.5,
    )
    session.start()
    await flush()
    socketAt(sockets, 0).emit('open')
    socketAt(sockets, 0).emit('close', 1008)
    await flush()
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true)
    expect(sockets).toHaveLength(2)

    session.stop()
    socketAt(sockets, 1).emit('close', 1006)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sockets).toHaveLength(2)
    expect(session.getStatus()).toMatchObject({
      state: 'DISCONNECTED',
      desiredConnected: false,
    })
  })

  it('uses bounded full-jitter reconnect backoff', async () => {
    const sockets: FakeSocket[] = []
    const session = new WebSocketSession(
      'wss://api.artcsworld.xyz/ws',
      { getAccessToken: () => Promise.resolve('token') },
      logger,
      () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      timers,
      () => 0.5,
    )
    session.start()
    await flush()
    socketAt(sockets, 0).emit('close', 1006)
    expect(session.getStatus()).toMatchObject({ state: 'BACKOFF', reconnectAttempt: 1 })
    await vi.advanceTimersByTimeAsync(499)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(sockets).toHaveLength(2)
  })

  it('strictly recognizes bounded reprocessed events and isolates listeners', async () => {
    const socket = new FakeSocket()
    const session = new WebSocketSession(
      'wss://api.artcsworld.xyz/ws',
      { getAccessToken: () => Promise.resolve('token') },
      logger,
      () => socket,
      timers,
    )
    const observed = vi.fn()
    session.subscribeReprocessed(() => {
      throw new Error('listener failed')
    })
    const unsubscribe = session.subscribeReprocessed(observed)
    session.start()
    await flush()
    socket.emit('open')
    socket.emit('message', JSON.stringify({ type: 'connection', status: 'connected' }))

    socket.emit('message', JSON.stringify({ type: 'ocr_reprocessed', data: 'raw' }))
    socket.emit(
      'message',
      JSON.stringify({ type: 'ocr_reprocessed', data: {}, unexpected: true }),
    )
    socket.emit(
      'message',
      JSON.stringify({ type: 'ocr_reprocessed', data: { raw: 'x'.repeat(2_049) } }),
    )
    expect(session.getStatus().unknownEventCount).toBe(3)

    const data = { success: true, player: { name: 'Safe player' }, decks: [] }
    socket.emit('message', JSON.stringify({ type: 'ocr_reprocessed', data }))
    expect(observed).toHaveBeenCalledWith(data)
    expect(session.getStatus().unknownEventCount).toBe(3)

    unsubscribe()
    socket.emit('message', JSON.stringify({ type: 'ocr_reprocessed', data }))
    expect(observed).toHaveBeenCalledTimes(1)
  })
})
