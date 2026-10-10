import { describe, expect, it, vi } from 'vitest'
import {
  H2HLookupResultSchema,
  H2HRequestSchema,
  H2HResponseSchema,
} from '../../../shared/contracts/h2h'
import { ApiClient } from './api-client'
import { H2HService } from './h2h-service'
import { ApiErrorSchema } from '../../../shared/errors/api-error'

const requestId = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
const payload = { requestId, opponentTag: '#jcu', recentLimit: 10 }
function response(status: 'ok' | 'none' | 'unavailable' | 'no_accounts') {
  const unavailable = status === 'unavailable' || status === 'no_accounts'
  return {
    status,
    opponent: { tag: '#JCU' },
    scope: 'recorded_path_of_legends',
    coverage: { source: 'cr_stats_current_and_archives', complete: false },
    updatedAt: '2026-10-10T00:00:00+00:00',
    stale: false,
    totals: {
      meetings: unavailable ? null : status === 'ok' ? 1 : 0,
      wins: unavailable ? null : status === 'ok' ? 1 : 0,
      losses: unavailable ? null : 0,
      draws: unavailable ? null : 0,
      decisiveMeetings: unavailable ? null : status === 'ok' ? 1 : 0,
      winRate: status === 'ok' ? 100 : null,
    },
    last: null,
    recent: [],
    perAccount: [],
  }
}
function harness() {
  let generation = 1
  let now = 0
  const request = vi
    .fn<(input: { signal: AbortSignal }) => Promise<unknown>>()
    .mockResolvedValue({ ok: true, status: 200, data: response('none') })
  const service = new H2HService(
    { request } as never,
    { getContextGeneration: () => generation } as never,
    () => now,
  )
  return {
    service,
    request,
    changeAuth: () => ++generation,
    advance: (ms: number) => {
      now += ms
    },
  }
}
describe('H2H client', () => {
  it.each(['ok', 'none', 'unavailable', 'no_accounts'] as const)(
    'preserves authoritative %s rather than inventing none',
    async (status) => {
      const test = harness()
      test.request.mockResolvedValue({ ok: true, status: 200, data: response(status) })
      const value = H2HLookupResultSchema.parse(await test.service.lookup(payload))
      expect(value).toMatchObject({ capability: 'supported', data: { status } })
      expect(test.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/user/me/h2h',
          query: { opponent_tag: '#JCU', recent_limit: 10 },
        }),
      )
    },
  )
  it('reports old-server 404 as unsupported', async () => {
    const test = harness()
    test.request.mockResolvedValue({ ok: false, error: { status: 404 } })
    expect(await test.service.lookup(payload)).toMatchObject({
      capability: 'unsupported',
      code: 'H2H_UNSUPPORTED',
    })
  })
  it('honors per-user Retry-After without making requests during cooldown', async () => {
    const test = harness()
    test.request.mockResolvedValue({
      ok: false,
      error: { status: 429, retryAfterSeconds: 12 },
    })
    expect(await test.service.lookup(payload)).toMatchObject({
      capability: 'rate_limited',
      retryAt: '1970-01-01T00:00:12.000Z',
    })
    await test.service.lookup({ ...payload, opponentTag: '#PYL' })
    expect(test.request).toHaveBeenCalledTimes(1)
    test.advance(12_000)
    await test.service.lookup(payload)
    expect(test.request).toHaveBeenCalledTimes(2)
    test.changeAuth()
    await test.service.lookup(payload)
    expect(test.request).toHaveBeenCalledTimes(3)
  })
  it('coalesces canonical same-opponent requests and cancellation does not cancel another consumer', async () => {
    const test = harness()
    const gate = Promise.withResolvers<unknown>()
    test.request.mockImplementation(() => gate.promise)
    const first = test.service.lookup(payload)
    const second = test.service.lookup({
      ...payload,
      requestId: otherId,
      opponentTag: 'JCU',
    })
    expect(test.request).toHaveBeenCalledTimes(1)
    test.service.cancel(requestId)
    expect(await first).toMatchObject({ capability: 'cancelled' })
    expect(test.request.mock.calls[0]?.[0].signal.aborted).toBe(false)
    gate.resolve({ ok: true, status: 200, data: response('none') })
    expect(await second).toMatchObject({ requestId: otherId, capability: 'supported' })
  })
  it('aborts a superseded palette lookup and rejects old auth results', async () => {
    const test = harness()
    const gate = Promise.withResolvers<unknown>()
    test.request.mockImplementation(() => gate.promise)
    const pending = test.service.lookup(payload)
    test.service.cancelAll()
    expect(await pending).toMatchObject({ capability: 'cancelled' })
    expect(test.request.mock.calls[0]?.[0].signal.aborted).toBe(true)
    const other = test.service.lookup({ ...payload, requestId: otherId })
    test.changeAuth()
    gate.resolve({ ok: true, status: 200, data: response('none') })
    expect(await other).toMatchObject({ capability: 'cancelled' })
  })
  it('rejects invalid tags/limits/unknown fields before HTTP', async () => {
    const test = harness()
    for (const invalid of [
      { ...payload, opponentTag: '#BAD' },
      { ...payload, recentLimit: 11 },
      { ...payload, token: 'bad' },
    ]) {
      expect(H2HRequestSchema.safeParse(invalid).success).toBe(false)
      await expect(test.service.lookup(invalid)).rejects.toThrow()
    }
    expect(test.request).not.toHaveBeenCalled()
    expect(
      H2HResponseSchema.safeParse({ ...response('none'), secret: 'bad' }).success,
    ).toBe(false)
  })
  it('never turns malformed/network/auth responses into zero meetings', async () => {
    const test = harness()
    for (const error of [
      { code: 'NETWORK_UNAVAILABLE' },
      { code: 'UNAUTHORIZED', status: 401 },
      { code: 'FORBIDDEN', status: 403 },
    ]) {
      test.request.mockResolvedValue({ ok: false, error })
      expect(await test.service.lookup(payload)).toMatchObject({
        capability: 'unavailable',
      })
    }
  })
  it.each(['12', new Date(Date.now() + 12_000).toUTCString()])(
    'preserves Retry-After %s at the HTTP boundary',
    async (retryAfter) => {
      const api = new ApiClient(
        { apiUrl: 'https://example.test' } as never,
        vi.fn().mockResolvedValue(
          new Response('<html>old proxy</html>', {
            status: 429,
            headers: { 'Retry-After': retryAfter },
          }),
        ),
        { debug: vi.fn(), warn: vi.fn() },
      )
      const result = await api.request({
        method: 'GET',
        path: '/api/user/me/h2h',
        schema: H2HResponseSchema,
      })
      expect(result).toMatchObject({ ok: false, error: { status: 429 } })
      if (!result.ok) expect(result.error.retryAfterSeconds).toBeGreaterThan(10)
    },
  )
  it('handles non-JSON old-server 404 without crashing', async () => {
    const api = new ApiClient(
      { apiUrl: 'https://example.test' } as never,
      vi.fn().mockResolvedValue(new Response('Not found', { status: 404 })),
      { debug: vi.fn(), warn: vi.fn() },
    )
    expect(
      await api.request({
        method: 'GET',
        path: '/api/user/me/h2h',
        schema: H2HResponseSchema,
      }),
    ).toMatchObject({ ok: false, error: { status: 404 } })
  })
})

describe('H2H long Retry-After handling', () => {
  it('does not shorten a valid multi-day server deadline', async () => {
    const api = new ApiClient(
      { apiUrl: 'https://example.test' } as never,
      vi
        .fn()
        .mockResolvedValue(
          new Response('Busy', { status: 429, headers: { 'Retry-After': '172800' } }),
        ),
      { debug: vi.fn(), warn: vi.fn() },
    )
    const response = await api.request({
      method: 'GET',
      path: '/api/user/me/h2h',
      schema: H2HResponseSchema,
    })
    if (response.ok) throw new Error('Expected a rate-limit response')
    expect(ApiErrorSchema.parse(response.error).retryAfterSeconds).toBe(172800)
    const test = harness()
    test.request.mockResolvedValue(response)
    expect(await test.service.lookup(payload)).toMatchObject({
      capability: 'rate_limited',
      retryAt: '1970-01-03T00:00:00.000Z',
    })
    test.advance(86_401_000)
    expect(await test.service.lookup(payload)).toMatchObject({
      capability: 'rate_limited',
    })
    expect(test.request).toHaveBeenCalledOnce()
  })

  it('keeps an unrepresentably distant deadline without crashing or retrying early', async () => {
    const test = harness()
    test.request.mockResolvedValue({
      ok: false,
      error: { status: 429, retryAfterSeconds: Number.MAX_VALUE },
    })
    expect(H2HLookupResultSchema.parse(await test.service.lookup(payload))).toMatchObject(
      { capability: 'rate_limited', retryAt: null },
    )
    test.advance(Number.MAX_SAFE_INTEGER)
    expect(await test.service.lookup({ ...payload, requestId: otherId })).toMatchObject({
      capability: 'rate_limited',
      retryAt: null,
    })
    expect(test.request).toHaveBeenCalledOnce()
  })
})

describe('review regression additive H2H evolution', () => {
  it('#7 strips additive HTTP fields while preserving real stale and complete values in strict IPC', async () => {
    const data = {
      ...response('ok'),
      newServerField: true,
      stale: true,
      opponent: { tag: '#JCU', serverHint: 'new' },
      coverage: { source: 'cr_stats_current_and_archives', complete: true, extra: 1 },
      totals: { ...response('ok').totals, extra: 2 },
      recent: [
        { at: '2026-10-10T00:00:00Z', result: 'win', accountTag: '#JCU', extra: true },
      ],
      last: {
        at: '2026-10-10T00:00:00Z',
        result: 'win',
        accountTag: '#JCU',
        extra: true,
      },
      perAccount: [
        {
          accountTag: '#JCU',
          alias: 'Account',
          meetings: 1,
          wins: 1,
          losses: 0,
          draws: 0,
          decisiveMeetings: 1,
          winRate: 100,
          lastAt: null,
          lastResult: null,
          extra: true,
        },
      ],
    }
    const api = new ApiClient(
      { apiUrl: 'https://example.test' } as never,
      vi.fn().mockResolvedValue(new Response(JSON.stringify(data))),
      { debug: vi.fn(), warn: vi.fn() },
    )
    const test = harness()
    test.request.mockImplementation((input) =>
      api.request({
        method: 'GET',
        path: '/api/user/me/h2h',
        schema: (input as typeof input & { schema: typeof H2HResponseSchema }).schema,
        signal: input.signal,
      }),
    )
    const result = H2HLookupResultSchema.parse(await test.service.lookup(payload))
    expect(result).toMatchObject({
      capability: 'supported',
      data: { stale: true, coverage: { complete: true } },
    })
    if (result.capability !== 'supported') throw new Error('Missing supported H2H data')
    expect(result.data).not.toHaveProperty('newServerField')
    expect(result.data.opponent).not.toHaveProperty('serverHint')
    expect(result.data.recent[0]).not.toHaveProperty('extra')
    expect(result.data.perAccount[0]).not.toHaveProperty('extra')
    expect(
      H2HLookupResultSchema.safeParse({
        ...result,
        data: { ...result.data, extra: true },
      }).success,
    ).toBe(false)
  })
})
