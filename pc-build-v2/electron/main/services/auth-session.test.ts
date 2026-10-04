import { describe, expect, it, vi } from 'vitest'

import { ApplicationError } from '../../../shared/errors/application-error'
import { createProductionServerConfig } from '../infrastructure/server-config'
import { ApiClient, AuthenticatedApiClient } from './api-client'
import { ServerMeResponseSchema } from '../../../shared/contracts/server'
import {
  AuthSession,
  type AuthSessionRevoker,
  type RefreshTokenStore,
} from './auth-session'
import { DeviceIdentityService, type DeviceRawData } from './device-identity-service'

const device: DeviceRawData = {
  cpuProcessorId: 'CPU',
  cpuModel: null,
  motherboardSerial: 'BOARD',
  diskSerials: ['DISK'],
  networkInterfaces: {},
  platform: 'win32',
  arch: 'x64',
  release: '10',
}
const user = {
  id: 42,
  username: 'operator',
  email: 'operator@example.com',
  role: 'premium',
  roles: ['premium'],
  ignored: 'server-extra',
}
const logger = { debug: vi.fn(), warn: vi.fn() }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestPath(input: string | URL | Request): string {
  return new URL(input instanceof Request ? input.url : input).pathname
}

function requestBody(
  call: Parameters<typeof fetch> | undefined,
): Record<string, unknown> {
  const body = call?.[1]?.body
  if (typeof body !== 'string') throw new Error('Expected JSON request body')
  return JSON.parse(body) as Record<string, unknown>
}

function firstPath(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): string {
  const call = fetchMock.mock.calls[0]
  if (call === undefined) throw new Error('Expected an API request')
  return requestPath(call[0])
}

function store(initial: string | null): RefreshTokenStore & {
  value: string | null
  invalidated: boolean
  saves: number
  clears: number
} {
  return {
    value: initial,
    invalidated: false,
    saves: 0,
    clears: 0,
    loadRefreshToken() {
      if (this.invalidated) {
        return Promise.reject(
          new ApplicationError('SECRET_CLEAR_FAILED', 'durable logout marker'),
        )
      }
      return Promise.resolve(this.value)
    },
    saveRefreshToken(token) {
      this.value = token
      this.invalidated = false
      this.saves += 1
      return Promise.resolve()
    },
    invalidateAndClear() {
      this.invalidated = true
      this.value = null
      this.clears += 1
      this.invalidated = false
      return Promise.resolve()
    },
  }
}

function session(
  fetchImplementation: typeof fetch,
  secrets = store('refresh-1'),
  bootstrapTimeoutMs = 30_000,
  revoker?: AuthSessionRevoker,
): { auth: AuthSession; secrets: ReturnType<typeof store> } {
  const api = new ApiClient(createProductionServerConfig(), fetchImplementation, logger)
  const identity = new DeviceIdentityService({ collect: () => Promise.resolve(device) })
  return {
    auth: new AuthSession(api, secrets, identity, revoker, bootstrapTimeoutMs),
    secrets,
  }
}

describe('AuthSession', () => {
  it('bootstraps through refresh and /me, projecting a strict token-free user', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('refresh'))
        return Promise.resolve(
          json({
            success: true,
            tokens: { access_token: 'access-1', refresh_token: 'refresh-2' },
          }),
        )
      return Promise.resolve(json({ user }))
    })
    const { auth, secrets } = session(fetchMock)
    await expect(auth.bootstrap()).resolves.toMatchObject({
      state: 'AUTHENTICATED',
      user: {
        id: '42',
        username: 'operator',
        email: 'operator@example.com',
        role: 'premium',
        roles: ['premium'],
      },
      error: null,
    })
    expect(auth.getView().user).not.toHaveProperty('ignored')
    expect(auth.getView()).not.toHaveProperty('accessToken')
    expect(secrets.value).toBe('refresh-2')
    expect(fetchMock.mock.calls.map(([url]) => requestPath(url))).toEqual([
      '/api/auth/refresh',
      '/api/auth/me',
    ])
  })

  it('coalesces twenty concurrent forced refresh calls into one request', async () => {
    let refreshCalls = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('refresh')) {
        refreshCalls += 1
        return Promise.resolve(
          json({
            tokens: { access_token: `access-${refreshCalls}`, refresh_token: 'refresh' },
          }),
        )
      }
      return Promise.resolve(json(user))
    })
    const { auth } = session(fetchMock)
    await auth.bootstrap()
    const before = refreshCalls
    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => auth.getAccessToken(true)),
    )
    expect(refreshCalls - before).toBe(1)
    expect(new Set(tokens).size).toBe(1)
  })

  it('ignores refresh completion after logout', async () => {
    let releaseRefresh: ((response: Response) => void) | undefined
    let refreshCalls = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('refresh')) {
        refreshCalls += 1
        if (refreshCalls === 1)
          return Promise.resolve(
            json({ tokens: { access_token: 'initial', refresh_token: 'refresh' } }),
          )
        return new Promise((resolve) => {
          releaseRefresh = resolve
        })
      }
      return Promise.resolve(json(user))
    })
    const { auth, secrets } = session(fetchMock)
    await auth.bootstrap()
    const pending = auth.getAccessToken(true)
    await auth.logout()
    releaseRefresh?.(
      json({ tokens: { access_token: 'stale', refresh_token: 'stale-refresh' } }),
    )
    await expect(pending).resolves.toBeNull()
    expect(auth.getView().state).toBe('UNAUTHENTICATED')
    expect(secrets.value).toBeNull()
    await expect(auth.getAccessToken()).resolves.toBeNull()
  })

  it('invokes revocation but always completes durable local invalidation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('refresh')) {
        return Promise.resolve(
          json({ tokens: { access_token: 'access', refresh_token: 'refresh-current' } }),
        )
      }
      return Promise.resolve(json(user))
    })
    const failingRevoker = {
      revoke: vi.fn().mockRejectedValue(new Error('network unavailable')),
    }
    const local = store('refresh-old')
    const { auth } = session(fetchMock, local, 30_000, failingRevoker)
    await auth.bootstrap()

    await expect(auth.logout()).resolves.toMatchObject({
      state: 'UNAUTHENTICATED',
      user: null,
      error: null,
    })
    expect(failingRevoker.revoke).toHaveBeenCalledWith('refresh-current')
    expect(local.value).toBeNull()
    expect(local.clears).toBe(1)

    const failedLocal = store('refresh-old')
    const successfulRevoker = { revoke: vi.fn().mockResolvedValue(undefined) }
    const second = session(fetchMock, failedLocal, 30_000, successfulRevoker).auth
    await second.bootstrap()
    failedLocal.invalidateAndClear = () => {
      failedLocal.invalidated = true
      return Promise.reject(new Error('local delete denied'))
    }
    await expect(second.logout()).resolves.toMatchObject({
      state: 'ERROR',
      error: { code: 'SECRET_CLEAR_FAILED' },
    })
    expect(successfulRevoker.revoke).toHaveBeenCalledWith('refresh-current')
  })

  it('cancels an in-flight bootstrap without committing a stale auth result', async () => {
    let requestStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      requestStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const rejectAbort = (): void => reject(new Error('request aborted'))
        if (signal?.aborted === true) rejectAbort()
        else signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })
    const { auth } = session(fetchMock, store('refresh-1'))

    const bootstrap = auth.bootstrap()
    await started
    auth.cancelPendingOperations()

    await expect(bootstrap).resolves.toMatchObject({ state: 'BOOTSTRAPPING' })
    expect(auth.getView()).toMatchObject({ state: 'BOOTSTRAPPING', user: null })
  })

  it('turns a stalled bootstrap into a retryable timeout state', async () => {
    const stalledFetch = vi
      .fn<typeof fetch>()
      .mockReturnValue(new Promise(() => undefined))
    const { auth } = session(stalledFetch, store('refresh-1'), 10)

    await expect(auth.bootstrap()).resolves.toMatchObject({
      state: 'ERROR',
      error: { code: 'REQUEST_TIMEOUT', retryable: true },
    })
  })

  it('clears a refresh token whose encrypted write finishes after logout', async () => {
    let releaseSave: (() => void) | undefined
    let saveStarted: (() => void) | undefined
    const saveStartedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve
    })
    const delayedStore = store('refresh-1')
    delayedStore.saveRefreshToken = async (token) => {
      delayedStore.value = token
      delayedStore.saves += 1
      saveStarted?.()
      await new Promise<void>((resolve) => {
        releaseSave = resolve
      })
    }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('refresh')) {
        return Promise.resolve(
          json({ tokens: { access_token: 'stale', refresh_token: 'stale-refresh' } }),
        )
      }
      return Promise.resolve(json(user))
    })
    const { auth } = session(fetchMock, delayedStore)
    const bootstrap = auth.bootstrap()
    await saveStartedPromise
    const logout = auth.logout()
    releaseSave?.()
    await Promise.all([bootstrap, logout])

    expect(auth.getView().state).toBe('UNAUTHENTICATED')
    expect(delayedStore.value).toBeNull()
  })

  it('reports failed secret clearing and never reloads the retained refresh token', async () => {
    const retainedStore = store('refresh-1')
    let clearAttempts = 0
    retainedStore.invalidateAndClear = () => {
      clearAttempts += 1
      retainedStore.invalidated = true
      return Promise.reject(new Error('storage denied'))
    }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('refresh')) {
        return Promise.resolve(
          json({ tokens: { access_token: 'access', refresh_token: 'refresh-1' } }),
        )
      }
      return Promise.resolve(json(user))
    })
    const { auth } = session(fetchMock, retainedStore)
    await auth.bootstrap()
    const refreshCallsBeforeLogout = fetchMock.mock.calls.filter(([url]) =>
      requestPath(url).endsWith('refresh'),
    ).length

    await expect(auth.logout()).resolves.toMatchObject({
      state: 'ERROR',
      user: null,
      error: { code: 'SECRET_CLEAR_FAILED', retryable: true },
    })
    await expect(auth.getAccessToken()).resolves.toBeNull()
    await expect(auth.retryBootstrap()).resolves.toMatchObject({
      state: 'ERROR',
      error: { code: 'SECRET_CLEAR_FAILED' },
    })
    expect(clearAttempts).toBe(2)
    expect(
      fetchMock.mock.calls.filter(([url]) => requestPath(url).endsWith('refresh')),
    ).toHaveLength(refreshCallsBeforeLogout)
    expect(retainedStore.value).toBe('refresh-1')

    const restarted = session(fetchMock, retainedStore).auth
    await expect(restarted.bootstrap()).resolves.toMatchObject({
      state: 'ERROR',
      error: { code: 'SECRET_CLEAR_FAILED' },
    })
    expect(
      fetchMock.mock.calls.filter(([url]) => requestPath(url).endsWith('refresh')),
    ).toHaveLength(refreshCallsBeforeLogout)
  })

  it.each([
    [401, 'UNAUTHENTICATED'],
    [403, 'BLOCKED'],
  ] as const)(
    'keeps a durable tombstone when %s auth cleanup cannot delete it',
    async (status, expectedState) => {
      const retainedStore = store('refresh-1')
      retainedStore.invalidateAndClear = () => {
        retainedStore.invalidated = true
        retainedStore.clears += 1
        return Promise.reject(new Error('delete denied'))
      }
      let refreshCalls = 0
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
        const path = requestPath(url)

        if (path.endsWith('refresh')) {
          refreshCalls += 1
          return Promise.resolve(json({ message: 'expired' }, status))
        }
        return Promise.resolve(json(user))
      })

      await expect(
        session(fetchMock, retainedStore).auth.bootstrap(),
      ).resolves.toMatchObject({
        state: expectedState,
        user: null,
      })
      expect(retainedStore.invalidated).toBe(true)
      expect(refreshCalls).toBe(1)

      await expect(
        session(fetchMock, retainedStore).auth.bootstrap(),
      ).resolves.toMatchObject({
        state: 'ERROR',
        error: { code: 'SECRET_CLEAR_FAILED' },
      })
      expect(refreshCalls).toBe(1)
    },
  )

  it('refreshes once after /me 401 and maps 403 to blocked', async () => {
    let refreshCalls = 0
    let meCalls = 0
    const fetch401 = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('refresh')) {
        refreshCalls += 1
        return Promise.resolve(
          json({ tokens: { access_token: `a${refreshCalls}`, refresh_token: 'r' } }),
        )
      }
      meCalls += 1
      return Promise.resolve(
        meCalls === 1 ? json({ message: 'expired' }, 401) : json(user),
      )
    })
    const first = session(fetch401).auth
    expect((await first.bootstrap()).state).toBe('AUTHENTICATED')
    expect(refreshCalls).toBe(2)
    expect(meCalls).toBe(2)

    const fetch403 = vi.fn<typeof fetch>().mockImplementation(() => {
      return Promise.resolve(json({ message: 'blocked' }, 403))
    })
    expect((await session(fetch403).auth.bootstrap()).state).toBe('BLOCKED')
  })

  it('reports invalid encrypted state and server outages as actionable errors', async () => {
    const availableFetch = vi.fn<typeof fetch>().mockResolvedValue(json(user))
    const invalidStore = store(null)
    invalidStore.loadRefreshToken = () =>
      Promise.reject(new ApplicationError('SECRET_INVALID', 'corrupt secret'))
    const invalid = session(availableFetch, invalidStore).auth
    expect(await invalid.bootstrap()).toMatchObject({
      state: 'ERROR',
      error: { code: 'SECRET_INVALID' },
    })

    const unavailableFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const unavailable = session(unavailableFetch).auth
    expect(await unavailable.bootstrap()).toMatchObject({
      state: 'ERROR',
      error: { code: 'NETWORK_UNAVAILABLE', retryable: true },
    })
  })

  it('authenticates directly when registration returns tokens', async () => {
    const secrets = store(null)
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)

      if (path.endsWith('register'))
        return Promise.resolve(
          json({
            success: true,
            tokens: { access_token: 'a', refresh_token: 'r' },
            user,
          }),
        )
      return Promise.resolve(json(user))
    })
    const { auth } = session(fetchMock, secrets)
    expect((await auth.bootstrap()).state).toBe('UNAUTHENTICATED')
    expect(
      (
        await auth.register(
          'operator@example.com',
          'operator',
          'password123',
          'test_key-123',
        )
      ).state,
    ).toBe('AUTHENTICATED')
    expect(secrets.value).toBe('r')
    expect(requestBody(fetchMock.mock.calls[0])['hwid']).toMatch(/^[a-f0-9]{64}$/)
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject({
      email: 'operator@example.com',
      username: 'operator',
      password: 'password123',
      invite_key: 'test_key-123',
    })
  })

  it('starts offline at login without making any API request when no token is saved', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    const { auth } = session(fetchMock, store(null))
    await expect(auth.bootstrap()).resolves.toEqual({
      state: 'UNAUTHENTICATED',
      user: null,
      error: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(auth.logout()).resolves.toMatchObject({ state: 'UNAUTHENTICATED' })
  })

  it('logs in on an unfamiliar PC without checking or activating a key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        tokens: { access_token: 'access-new-pc', refresh_token: 'refresh-new-pc' },
        user,
      }),
    )
    const { auth, secrets } = session(fetchMock, store(null))
    await expect(
      auth.login('operator@example.com', 'password123'),
    ).resolves.toMatchObject({
      state: 'AUTHENTICATED',
      error: null,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(firstPath(fetchMock)).toBe('/api/auth/login')
    expect(requestBody(fetchMock.mock.calls[0])['hwid']).toMatch(/^[a-f0-9]{64}$/)
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject({
      email: 'operator@example.com',
      password: 'password123',
    })
    expect(secrets.value).toBe('refresh-new-pc')
  })

  it.each([
    [403, 'Этот ключ уже привязан к другому аккаунту'],
    [400, 'Пользователь с таким email уже существует'],
  ])(
    'keeps registration editable after HTTP %s without mutating secrets',
    async (status, message) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ detail: message }, status))
      const { auth, secrets } = session(fetchMock, store(null))
      await expect(
        auth.register(
          'operator@example.com',
          'operator',
          'password123',
          ' test_key-123 ',
        ),
      ).resolves.toMatchObject({
        state: 'UNAUTHENTICATED',
        user: null,
        error: { message, status },
      })
      expect(requestBody(fetchMock.mock.calls[0])['hwid']).toMatch(/^[a-f0-9]{64}$/)
      expect(requestBody(fetchMock.mock.calls[0])).toMatchObject({
        invite_key: 'test_key-123',
      })
      expect(secrets.saves).toBe(0)
      expect(secrets.clears).toBe(0)
    },
  )

  it.each([
    [403, 'Подписка не активна. Продлите ключ доступа.', 'BLOCKED'],
    [401, 'Неверный email или пароль', 'UNAUTHENTICATED'],
  ])(
    'preserves login HTTP %s detail and can return from a blocked account',
    async (status, message, state) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ detail: message }, status))
      const { auth, secrets } = session(fetchMock, store(null))
      await expect(
        auth.login('operator@example.com', 'password123'),
      ).resolves.toMatchObject({
        state,
        user: null,
        error: { message, status },
      })
      if (state === 'BLOCKED') {
        expect(secrets.clears).toBe(1)
        expect(auth.resetLogin()).toEqual({
          state: 'UNAUTHENTICATED',
          user: null,
          error: null,
        })
        expect(fetchMock).toHaveBeenCalledOnce()
      }
    },
  )

  it.each(['bootstrap', 'refresh', 'request'] as const)(
    'clears a replaced session during %s and exposes its server message',
    async (operation) => {
      const message = 'Выполнен вход на другом устройстве'
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
        if (operation === 'bootstrap' || fetchMock.mock.calls.length > 2) {
          return Promise.resolve(json({ detail: message }, 401))
        }
        if (requestPath(url).endsWith('refresh')) {
          return Promise.resolve(
            json({ tokens: { access_token: 'access', refresh_token: 'refresh' } }),
          )
        }
        return Promise.resolve(json(user))
      })
      const { auth, secrets } = session(fetchMock)
      await auth.bootstrap()
      if (operation === 'refresh')
        await expect(auth.getAccessToken(true)).resolves.toBeNull()
      if (operation === 'request') {
        const client = new AuthenticatedApiClient(
          new ApiClient(createProductionServerConfig(), fetchMock, logger),
          auth,
        )
        await expect(
          client.request({
            method: 'GET',
            path: '/api/auth/me',
            schema: ServerMeResponseSchema,
          }),
        ).resolves.toMatchObject({ ok: false, error: { message } })
      }
      expect(auth.getView()).toMatchObject({
        state: 'UNAUTHENTICATED',
        user: null,
        error: { code: 'UNAUTHORIZED', message },
      })
      expect(secrets.value).toBeNull()
      expect(secrets.clears).toBe(1)
      await expect(auth.getAccessToken()).resolves.toBeNull()
      expect(
        fetchMock.mock.calls.every(
          ([url]) => !requestPath(url).startsWith('/api/invite-keys/'),
        ),
      ).toBe(true)
    },
  )
})
