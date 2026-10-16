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
  it.each([
    [400, 'ACCOUNT_NOT_FOUND'],
    [400, 'ACCOUNT_TAG_INVALID'],
    [400, 'ACCOUNT_LIMIT_REACHED'],
    [409, 'ACCOUNT_LIMIT_REACHED'],
    [503, 'CLASH_API_UNAVAILABLE'],
    [503, 'ACCOUNT_SAVE_UNAVAILABLE'],
  ] as const)(
    'preserves allowlisted account code regardless of status: %s/%s',
    async (status, code) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ code, detail: 'safe detail' }), { status }),
        )
      const client = new ApiClient(createProductionServerConfig(), fetchMock, logger)
      await expect(
        client.request({ method: 'POST', path: '/api/streamer/accounts', schema }),
      ).resolves.toMatchObject({ ok: false, error: { code, message: 'safe detail' } })
    },
  )
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
    expect(new Headers(call?.[1]?.headers).get('X-Client-Platform')).toBe('windows')
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

  it.each([500, 502, 503, 504])(
    'preserves HTTP %s for idempotent retries when its body is not JSON',
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Internal Server Error', { status }))
      const client = new ApiClient(createProductionServerConfig(), fetchMock, logger)
      await expect(
        client.request({
          method: 'POST',
          path: '/api/streamer/predictions/battle-start',
          schema,
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: 'SERVER_ERROR', status } })
    },
  )

  it.each([true, false])(
    'preserves bounded HTTP 5xx when the response is oversized (declared=%s)',
    async (declared) => {
      const response = new Response('x'.repeat(200), {
        status: 503,
        ...(declared ? { headers: { 'content-length': '9999' } } : {}),
      })
      const client = new ApiClient(
        createProductionServerConfig(),
        vi.fn<typeof fetch>().mockResolvedValue(response),
        logger,
        100,
      )
      await expect(
        client.request({
          method: 'POST',
          path: '/api/streamer/predictions/battle-result',
          schema,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'SERVER_ERROR', status: 503 },
      })
    },
  )

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

  it('does not refresh or retry when the owning auth context becomes stale', async () => {
    let current = true
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
      current = false
      return Promise.resolve(new Response('{"detail":"expired"}', { status: 401 }))
    })
    const auth = { getAccessToken: vi.fn().mockResolvedValue('owner-token') }
    const client = new AuthenticatedApiClient(
      new ApiClient(createProductionServerConfig(), fetchMock, logger),
      auth,
    )

    await expect(
      client.request({
        method: 'POST',
        path: '/api/test',
        schema,
        authContextGuard: () => current,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    expect(auth.getAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, 'UNAUTHORIZED', 'Неверный email или пароль'],
    [401, 'UNAUTHORIZED', 'Выполнен вход на другом устройстве'],
    [403, 'FORBIDDEN', 'Подписка не активна. Продлите ключ доступа.'],
    [403, 'FORBIDDEN', 'Этот ключ уже привязан к другому аккаунту'],
    [400, 'VALIDATION_FAILED', 'Пользователь с таким email уже существует'],
  ])('preserves HTTP %s auth detail', async (status, code, message) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ detail: message }), { status }))
    const client = new ApiClient(createProductionServerConfig(), fetchMock, logger)
    await expect(
      client.request({ method: 'POST', path: '/api/auth/login', schema }),
    ).resolves.toMatchObject({ ok: false, error: { code, message, status } })
  })
})

describe('review regression API error semantics', () => {
  it.each(['/api/auth/login', '/api/auth/register', '/api/streamer/accounts'] as const)(
    '#6 preserves bounded error bodies and Retry-After on %s',
    async (path) => {
      const message = 'Слишком много попыток. Попробуйте позже.'
      const client = new ApiClient(
        createProductionServerConfig(),
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ detail: message }), {
            status: 429,
            headers: { 'Retry-After': '12' },
          }),
        ),
        logger,
      )
      await expect(
        client.request({ method: 'POST', path, schema }),
      ).resolves.toMatchObject({
        ok: false,
        error: { status: 429, message, retryAfterSeconds: 12 },
      })
    },
  )
})

describe('review regression title receipt endpoint ownership', () => {
  it.each(['/api/auth/login', '/api/streamer/auth/connect'] as const)(
    '#14 does not interpret a title saved receipt on another endpoint: %s',
    async (path) => {
      const client = new ApiClient(
        createProductionServerConfig(),
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              code: 'TITLE_SAVED_APPLY_FAILED',
              detail: 'Not a title mutation',
            }),
            { status: 502 },
          ),
        ),
        logger,
      )
      await expect(
        client.request({ method: 'POST', path, schema }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'SERVER_ERROR', status: 502 },
      })
    },
  )
})

describe('review regression R1-C4 manual battle «nothing to skip»', () => {
  const BATTLE = '/api/streamer/predictions/current/battle'
  const LEAK = 'raw-server-text-must-not-reach-the-ui'
  const answering = (status: number, body: string) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status }))
    return {
      fetchMock,
      client: new ApiClient(createProductionServerConfig(), fetchMock, logger),
    }
  }

  it('preserves the nested code on POST current/battle 409 with a fixed message', async () => {
    const { fetchMock, client } = answering(
      409,
      JSON.stringify({ detail: { code: 'PREDICTION_NO_BATTLE_TO_SKIP', message: LEAK } }),
    )
    const result = await client.request({ method: 'POST', path: BATTLE, schema })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'PREDICTION_NO_BATTLE_TO_SKIP',
        message: 'No prediction battle to skip',
        retryable: false,
        status: 409,
      },
    })
    expect(JSON.stringify(result)).not.toContain(LEAK)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves the nested code through the authenticated client without a retry', async () => {
    const { fetchMock, client } = answering(
      409,
      JSON.stringify({ detail: { code: 'PREDICTION_NO_BATTLE_TO_SKIP' } }),
    )
    const authenticated = new AuthenticatedApiClient(client, {
      getAccessToken: vi.fn().mockResolvedValue('token'),
    })
    await expect(
      authenticated.request({ method: 'POST', path: BATTLE, schema }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'PREDICTION_NO_BATTLE_TO_SKIP', status: 409, retryable: false },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps a stale plain-string 409 as VALIDATION_FAILED', async () => {
    const { client } = answering(409, JSON.stringify({ detail: 'Prediction changed' }))
    await expect(
      client.request({ method: 'POST', path: BATTLE, schema }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', status: 409, retryable: false },
    })
  })

  it.each([
    [
      'unknown nested code',
      { detail: { code: 'PREDICTION_FUTURE_CODE', message: LEAK } },
    ],
    [
      'lower-case code',
      { detail: { code: 'prediction_no_battle_to_skip', message: LEAK } },
    ],
    ['top-level code', { code: 'PREDICTION_NO_BATTLE_TO_SKIP', message: { text: LEAK } }],
    [
      'code in an array detail',
      { detail: [{ code: 'PREDICTION_NO_BATTLE_TO_SKIP' }, LEAK] },
    ],
    [
      'code one level deeper',
      { detail: { detail: { code: 'PREDICTION_NO_BATTLE_TO_SKIP' } } },
    ],
    [
      'non-string code',
      { detail: { code: ['PREDICTION_NO_BATTLE_TO_SKIP'], message: LEAK } },
    ],
    ['null detail', { detail: null, error: { message: LEAK } }],
  ])('does not accept a spoofed code on current/battle: %s', async (_case, body) => {
    const { client } = answering(409, JSON.stringify(body))
    const result = await client.request({ method: 'POST', path: BATTLE, schema })
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', status: 409 },
    })
    expect(JSON.stringify(result)).not.toContain(LEAK)
  })

  it.each([
    ['POST', '/api/streamer/predictions/current/cancel', 409, 'VALIDATION_FAILED'],
    ['POST', '/api/streamer/predictions/battle-result', 409, 'VALIDATION_FAILED'],
    ['POST', '/api/streamer/predictions/battle-start', 409, 'VALIDATION_FAILED'],
    ['POST', '/api/streamer/accounts', 409, 'VALIDATION_FAILED'],
    ['PUT', BATTLE, 409, 'VALIDATION_FAILED'],
    ['DELETE', BATTLE, 409, 'VALIDATION_FAILED'],
    ['POST', BATTLE, 400, 'VALIDATION_FAILED'],
    ['POST', BATTLE, 422, 'VALIDATION_FAILED'],
    ['POST', BATTLE, 404, 'SERVER_ERROR'],
    ['POST', BATTLE, 403, 'FORBIDDEN'],
    ['POST', BATTLE, 503, 'SERVER_ERROR'],
  ] as const)(
    'keeps the generic mapping for %s %s HTTP %s',
    async (method, path, status, code) => {
      const { client } = answering(
        status,
        JSON.stringify({
          detail: { code: 'PREDICTION_NO_BATTLE_TO_SKIP', message: LEAK },
        }),
      )
      const result = await client.request({ method, path, schema })
      expect(result).toMatchObject({ ok: false, error: { code, status } })
      expect(JSON.stringify(result)).not.toContain(LEAK)
    },
  )

  it('keeps a non-JSON 409 on current/battle an invalid response', async () => {
    const { client } = answering(409, 'PREDICTION_NO_BATTLE_TO_SKIP')
    await expect(
      client.request({ method: 'POST', path: BATTLE, schema }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
  })

  it.each([
    ['non-JSON', 'Service Unavailable', {}],
    ['oversized', 'x'.repeat(200), { 'content-length': '9999' }],
  ] as const)(
    'keeps a %s 503 on current/battle a single SERVER_ERROR with its status',
    async (_case, body, headers) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 503, headers }))
      const client = new ApiClient(createProductionServerConfig(), fetchMock, logger, 100)
      await expect(
        client.request({ method: 'POST', path: BATTLE, schema }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'SERVER_ERROR', status: 503, retryable: true },
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    },
  )
})
