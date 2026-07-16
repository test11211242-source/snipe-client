import { describe, expect, it, vi } from 'vitest'

import { StreamerService } from './streamer-service'

const userView = {
  state: 'AUTHENTICATED' as const,
  user: {
    id: '42',
    username: 'caster',
    email: 'caster@example.com',
    role: 'premium' as const,
    roles: ['premium', 'streamer'] as const,
  },
  deviceHint: null,
  error: null,
}

function harness(connectUrl = 'https://id.twitch.tv/oauth2/authorize?client_id=x') {
  let activeMutations = 0
  let maxMutations = 0
  const request = vi.fn(
    async (input: {
      method: string
      path: string
      schema?: { safeParse: (value: unknown) => { success: boolean } }
    }) => {
      if (input.path.endsWith('/auth/connect'))
        return {
          ok: true as const,
          status: 200,
          data: { success: true, auth_url: connectUrl },
        }
      if (input.method !== 'GET') {
        activeMutations += 1
        maxMutations = Math.max(maxMutations, activeMutations)
        await Promise.resolve()
        activeMutations -= 1
        return { ok: true as const, status: 200, data: { success: true } }
      }
      if (input.path.endsWith('/auth/status'))
        return {
          ok: true as const,
          status: 200,
          data: { success: true, connected: true, username: 'caster' },
        }
      if (input.path.endsWith('/bot/status'))
        return {
          ok: true as const,
          status: 200,
          data: { success: true, status: { is_active: false, state: 'idle' } },
        }
      if (input.path.endsWith('/title/status'))
        return {
          ok: true as const,
          status: 200,
          data: { success: true, settings: {}, accounts: [] },
        }
      if (input.path.endsWith('/deck-sharing'))
        return {
          ok: true as const,
          status: 200,
          data: { success: true, settings: { enabled: false } },
        }
      return {
        ok: true as const,
        status: 200,
        data: {
          success: true,
          settings: {},
          opponent_widget_page_url:
            'https://api.artcsworld.xyz/opponent-widget?token=private-token',
          streamer_stats_widget_page_url:
            'https://api.artcsworld.xyz/streamer-stats-widget?token=private-token',
        },
      }
    },
  )
  const shell = { openExternal: vi.fn().mockResolvedValue(undefined) }
  const clipboard = { writeText: vi.fn() }
  const service = new StreamerService(
    { getView: () => userView } as never,
    { request } as never,
    {
      load: vi.fn().mockResolvedValue({
        predictionType: 'win_lose',
        predictionWindow: 60,
        winStreakCount: 2,
        delayBetweenPredictions: 5,
        autoCreateNext: true,
      }),
      save: vi.fn(),
    } as never,
    { load: vi.fn().mockResolvedValue({}) } as never,
    { load: vi.fn().mockResolvedValue({}) } as never,
    { getView: vi.fn().mockResolvedValue({ state: 'READY' }) } as never,
    {
      state: 'stopped',
      observeServerState: vi.fn(),
      startLifecycle: vi.fn(),
      shutdown: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as never,
    shell,
    clipboard,
    () => new Date('2026-07-12T12:00:00.000Z'),
  )
  return { service, request, shell, clipboard, maxMutations: () => maxMutations }
}

describe('StreamerService', () => {
  it('coalesces refresh callers and keeps full OBS URLs main-only', async () => {
    const test = harness()
    const first = test.service.refresh()
    const second = test.service.refresh()
    expect(first).toBe(second)
    const view = await first
    expect(view.refresh.state).toBe('ready')
    expect(JSON.stringify(view)).not.toContain('token=private-token')
    test.service.copyOverlayUrl('opponent')
    expect(test.clipboard.writeText).toHaveBeenCalledWith(
      'https://api.artcsworld.xyz/opponent-widget?token=private-token',
    )
  })

  it('serializes mutations and opens only an exact HTTPS Twitch host externally', async () => {
    const test = harness()
    await Promise.all([
      test.service.setDeckSharing(true),
      test.service.setDeckSharing(false),
    ])
    expect(test.maxMutations()).toBe(1)
    await test.service.connectTwitch()
    expect(test.shell.openExternal).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/id\.twitch\.tv\/oauth2\/authorize/),
    )

    const rejected = harness('https://id.twitch.tv.evil.example/oauth2/authorize')
    await expect(rejected.service.connectTwitch()).rejects.toMatchObject({
      code: 'TWITCH_OAUTH_URL_REJECTED',
    })
    expect(rejected.shell.openExternal).not.toHaveBeenCalled()
  })

  it('gates every management operation on authoritative streamer roles', async () => {
    const test = harness()
    Object.assign(userView.user, { roles: ['premium'] })
    await expect(test.service.setDeckSharing(true)).rejects.toMatchObject({
      code: 'STREAMER_ROLE_REQUIRED',
    })
    expect(test.request).not.toHaveBeenCalled()
    Object.assign(userView.user, { roles: ['premium', 'streamer'] })
  })

  it('fences a cancelled stale refresh from overwriting newer section data', async () => {
    const test = harness()
    let release: (() => void) | undefined
    test.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              status: 200,
              data: { success: true, connected: true, username: 'stale-caster' },
            })
        }),
    )
    const stale = test.service.refresh()
    test.service.setSectionActive(false)
    const current = await test.service.refresh()
    expect(current.twitch.connected).toBe(true)
    release?.()
    await stale
    expect(test.service.getView().twitch.username).toBe('caster')
  })

  it.each([
    [
      'disconnect without a server token',
      (service: StreamerService) => service.disconnectTwitch(),
    ],
    [
      'undo without title history',
      (service: StreamerService) => service.titleCommand('undo'),
    ],
    [
      'restore without a saved title',
      (service: StreamerService) => service.titleCommand('restore-title'),
    ],
  ])('reports a false 2xx command honestly for %s', async (_name, command) => {
    const test = harness()
    test.request.mockImplementationOnce((input) => {
      expect(input.schema?.safeParse({ success: false }).success).toBe(false)
      expect(input.schema?.safeParse({ success: true, ignored: true }).success).toBe(true)
      return Promise.resolve({
        ok: false,
        error: {
          code: 'INVALID_RESPONSE',
          message: 'invalid command response',
          retryable: true,
          status: 200,
        },
      } as never)
    })
    await expect(command(test.service)).rejects.toMatchObject({
      code: 'STREAMER_COMMAND_FAILED',
    })
  })
})
