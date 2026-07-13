import { describe, expect, it, vi } from 'vitest'

import { ApplicationError } from '../../../shared/errors/application-error'
import { createProductionServerConfig } from '../infrastructure/server-config'
import { ApiClient } from './api-client'
import { AuthSession, type RefreshTokenStore } from './auth-session'
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

function store(
  initial: string | null,
): RefreshTokenStore & { value: string | null; saves: number; clears: number } {
  return {
    value: initial,
    saves: 0,
    clears: 0,
    loadRefreshToken() {
      return Promise.resolve(this.value)
    },
    saveRefreshToken(token) {
      this.value = token
      this.saves += 1
      return Promise.resolve()
    },
    clear() {
      this.value = null
      this.clears += 1
      return Promise.resolve()
    },
  }
}

function session(
  fetchImplementation: typeof fetch,
  secrets = store('refresh-1'),
): { auth: AuthSession; secrets: ReturnType<typeof store> } {
  const api = new ApiClient(createProductionServerConfig(), fetchImplementation, logger)
  const identity = new DeviceIdentityService({ collect: () => Promise.resolve(device) })
  return { auth: new AuthSession(api, secrets, identity), secrets }
}

describe('AuthSession', () => {
  it('bootstraps through refresh and /me, projecting a strict token-free user', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)
      if (path.endsWith('check-hwid')) return Promise.resolve(json({ has_access: true }))
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
  })

  it('coalesces twenty concurrent forced refresh calls into one request', async () => {
    let refreshCalls = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)
      if (path.endsWith('check-hwid')) return Promise.resolve(json({ has_access: true }))
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
      if (path.endsWith('check-hwid')) return Promise.resolve(json({ has_access: true }))
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
      if (path.endsWith('check-hwid')) return Promise.resolve(json({ has_access: true }))
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

  it('refreshes once after /me 401 and maps 403 to blocked', async () => {
    let refreshCalls = 0
    let meCalls = 0
    const fetch401 = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)
      if (path.endsWith('check-hwid')) return Promise.resolve(json({ has_access: true }))
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

    const fetch403 = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = requestPath(url)
      return Promise.resolve(
        path.endsWith('check-hwid')
          ? json({ has_access: true })
          : json({ message: 'blocked' }, 403),
      )
    })
    expect((await session(fetch403).auth.bootstrap()).state).toBe('BLOCKED')
  })

  it('reports invalid encrypted state and server outages as actionable errors', async () => {
    const availableFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ has_access: true }))
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
      if (path.endsWith('check-hwid')) return Promise.resolve(json({ has_access: true }))
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
      (await auth.register('operator@example.com', 'operator', 'password123')).state,
    ).toBe('AUTHENTICATED')
    expect(secrets.value).toBe('r')
  })
})
