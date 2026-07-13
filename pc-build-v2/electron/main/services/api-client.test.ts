import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'

import { createProductionServerConfig } from '../infrastructure/server-config'
import { ApiClient, AuthenticatedApiClient } from './api-client'

const debug = vi.fn<(message: string, context?: unknown) => void>()
const logger = {
  debug,
  warn: vi.fn<(message: string, context?: unknown) => void>(),
}
const schema = z.object({ ok: z.literal(true) }).strict()

describe('ApiClient', () => {
  it('sends bounded JSON to the fixed origin without exposing a token to logs', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = new ApiClient(createProductionServerConfig(), fetchMock, logger)
    const result = await client.request({
      method: 'GET',
      path: '/api/auth/me',
      accessToken: 'top-secret-token',
      schema,
    })

    expect(result).toMatchObject({ ok: true, data: { ok: true } })
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe('https://api.artcsworld.xyz/api/auth/me')
    expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe(
      'Bearer top-secret-token',
    )
    expect(JSON.stringify(debug.mock.calls)).not.toContain('top-secret-token')
  })

  it('normalizes 401 and rejects oversized and malformed responses', async () => {
    const responses = [
      new Response('{"message":"expired"}', { status: 401 }),
      new Response('{"ok":true}', { status: 200, headers: { 'content-length': '9999' } }),
      new Response('not-json', { status: 200 }),
    ]
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      const response = responses.shift()
      return response === undefined
        ? Promise.reject(new Error('No response fixture'))
        : Promise.resolve(response)
    })
    const client = new ApiClient(createProductionServerConfig(), fetchMock, logger, 100)

    await expect(
      client.request({ method: 'GET', path: '/api/auth/me', schema }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    await expect(
      client.request({ method: 'GET', path: '/api/auth/me', schema }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'RESPONSE_TOO_LARGE' } })
    await expect(
      client.request({ method: 'GET', path: '/api/auth/me', schema }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })

  it('aborts requests at the configured deadline', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const client = new ApiClient(createProductionServerConfig(), fetchMock, logger)
    const request = client.request({
      method: 'GET',
      path: '/api/auth/me',
      schema,
      timeoutMs: 25,
    })
    await vi.advanceTimersByTimeAsync(25)
    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'REQUEST_TIMEOUT' },
    })
    vi.useRealTimers()
  })

  it('cancels in-flight work from the owning session', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const client = new ApiClient(createProductionServerConfig(), fetchMock, logger)
    const owner = new AbortController()
    const request = client.request({
      method: 'GET',
      path: '/api/auth/me',
      schema,
      signal: owner.signal,
    })

    owner.abort()
    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'AUTH_CANCELLED', retryable: false },
    })
  })

  it('supports typed query, PUT and DELETE and refreshes authentication once on 401', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"detail":"expired"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const auth = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce('old')
        .mockResolvedValueOnce('new')
        .mockResolvedValue('new'),
    }
    const client = new AuthenticatedApiClient(
      new ApiClient(createProductionServerConfig(), fetchMock, logger),
      auth,
    )
    await expect(
      client.request({
        method: 'PUT',
        path: '/api/test',
        query: { limit: 2 },
        body: { enabled: true },
        schema,
      }),
    ).resolves.toMatchObject({ ok: true })
    await expect(
      client.request({ method: 'DELETE', path: '/api/test/item', schema }),
    ).resolves.toMatchObject({ ok: true })
    expect(auth.getAccessToken).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.artcsworld.xyz/api/test?limit=2',
    )
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer new',
    )
  })
})
