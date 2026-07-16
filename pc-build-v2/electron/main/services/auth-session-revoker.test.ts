import { describe, expect, it, vi } from 'vitest'

import { createProductionServerConfig } from '../infrastructure/server-config'
import { ApiClient } from './api-client'
import { ApiAuthSessionRevoker } from './auth-session-revoker'

describe('ApiAuthSessionRevoker', () => {
  it('posts only the bounded refresh token to the fixed logout endpoint', async () => {
    const token = 'private-refresh-token'
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, revoked_at: 'server-extension' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const debug = vi.fn()
    const warn = vi.fn()
    const revoker = new ApiAuthSessionRevoker(
      new ApiClient(createProductionServerConfig(), fetchImplementation, { debug, warn }),
    )

    await expect(revoker.revoke(token)).resolves.toBeUndefined()
    expect(fetchImplementation).toHaveBeenCalledOnce()
    const [url, init] = fetchImplementation.mock.calls[0] ?? []
    expect(url).toBe('https://api.artcsworld.xyz/api/auth/logout')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ refresh_token: token }))
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    expect(JSON.stringify([debug.mock.calls, warn.mock.calls])).not.toContain(token)
  })

  it('rejects oversized tokens before issuing a request', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const revoker = new ApiAuthSessionRevoker(
      new ApiClient(createProductionServerConfig(), fetchImplementation, {
        debug: vi.fn(),
        warn: vi.fn(),
      }),
    )

    await expect(revoker.revoke('x'.repeat(16_385))).rejects.toThrow()
    expect(fetchImplementation).not.toHaveBeenCalled()
  })
})
