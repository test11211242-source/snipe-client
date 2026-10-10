import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_TITLE_SETTINGS } from './streamer-adapters'
import { StreamerService } from './streamer-service'
import { createApiError } from '../../../shared/errors/api-error'
import { AccountMutationResultSchema } from '../../../shared/contracts/streamer-ipc'
import { ApiClient } from './api-client'
import { z } from 'zod'

const userView = {
  state: 'AUTHENTICATED' as const,
  user: {
    id: '42',
    username: 'caster',
    email: 'caster@example.com',
    role: 'premium' as const,
    roles: ['premium', 'streamer'] as const,
  },
  error: null,
}

function harness(
  connectUrl = 'https://id.twitch.tv/oauth2/authorize?client_id=x',
  activeProfile: object | null = null,
  resultConfig: object = {},
) {
  let authGeneration = 1
  let activeMutations = 0
  let maxMutations = 0
  const request = vi.fn(
    async (input: {
      method: string
      path: string
      body?: unknown
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
    { getView: () => userView, getContextGeneration: () => authGeneration } as never,
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
    { load: vi.fn().mockResolvedValue(resultConfig) } as never,
    {
      load: vi.fn().mockResolvedValue({}),
      getActive: vi.fn().mockResolvedValue(activeProfile),
      list: vi.fn().mockResolvedValue({
        activeProfileId: '00000000-0000-4000-8000-000000000001',
        profiles: [
          {
            profileId: '00000000-0000-4000-8000-000000000001',
            configurationRevision: 1,
            configurationFingerprint: 'a'.repeat(64),
          },
        ],
      }),
    } as never,
    { getView: vi.fn().mockResolvedValue({ state: 'READY', runIntent: true }) } as never,
    {
      state: 'stopped',
      observationGeneration: 0,
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
  return {
    service,
    request,
    shell,
    clipboard,
    maxMutations: () => maxMutations,
    changeAuth: () => ++authGeneration,
  }
}

describe('StreamerService', () => {
  it.each([
    'ACCOUNT_TAG_INVALID',
    'ACCOUNT_NOT_FOUND',
    'ACCOUNT_LIMIT_REACHED',
    'CLASH_API_UNAVAILABLE',
    'ACCOUNT_SAVE_UNAVAILABLE',
    'UNAUTHORIZED',
    'VALIDATION_FAILED',
  ] as const)('returns an IPC-safe account error: %s', async (code) => {
    const test = harness()
    test.request.mockResolvedValueOnce({
      ok: false,
      error: createApiError(code, 'bounded detail', false, 400),
    } as never)
    const result = AccountMutationResultSchema.parse(
      await test.service.addTitleAccount('#P0Y', 'Alias'),
    )
    expect(result).toEqual({
      ok: false,
      error: {
        code: code === 'VALIDATION_FAILED' ? 'UNKNOWN' : code,
        detail: code === 'VALIDATION_FAILED' ? null : 'bounded detail',
      },
    })
    expect(test.request).toHaveBeenCalledOnce()
  })
  it.each(['TITLE_UPDATE_FAILED', 'REFRESH_FAILED'] as const)(
    'distinguishes saved account warning: %s',
    async (warning) => {
      const test = harness()
      const original = test.request.getMockImplementation()
      if (original === undefined) throw new Error('Missing request fixture')
      test.request.mockImplementation(async (input) => {
        if (input.method === 'POST')
          return {
            ok: true,
            status: 200,
            data: {
              success: true,
              ...(warning === 'TITLE_UPDATE_FAILED' ? { warning } : {}),
            },
          } as never
        if (warning === 'REFRESH_FAILED' && input.path.endsWith('/title/status'))
          throw new Error('refresh failed')
        return original(input)
      })
      const result = AccountMutationResultSchema.parse(
        await test.service.addTitleAccount('#P0Y', 'Alias'),
      )
      expect(result).toMatchObject({ ok: true, warning })
    },
  )
  it('retains valid sections when a title response reports success false', async () => {
    const test = harness()
    await test.service.refresh()
    const previousTitle = test.service.getView().title
    const original = test.request.getMockImplementation()
    test.request.mockImplementation(async (input) => {
      if (input.path.endsWith('/title/status'))
        return {
          ok: true,
          status: 200,
          data: { success: false, error: 'unavailable' },
        } as never
      if (original === undefined) throw new Error('Missing request implementation')
      return original(input)
    })
    const next = await test.service.refresh()
    expect(next.refresh.state).toBe('partial')
    expect(next.refresh.errors.map((error) => error.section)).toEqual(['title'])
    expect(next.title).toEqual(previousTitle)
    expect(next.twitch.connected).toBe(true)
    expect(next.overlay.urlsAvailable.opponent).toBe(true)
  })
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

  it('maps title drafts through the read-only preview endpoint', async () => {
    const test = harness()
    const previousView = test.service.getView()
    test.request.mockImplementationOnce((input) => {
      expect(input).toMatchObject({
        method: 'POST',
        path: '/api/streamer/title/preview',
        body: {
          prefix_template: DEFAULT_TITLE_SETTINGS.prefixTemplate,
          include_rank: DEFAULT_TITLE_SETTINGS.includeRank,
        },
      })
      return Promise.resolve({
        ok: true,
        status: 200,
        data: {
          success: true,
          preview_title: '#12 | 2400 | 3W-1L | Championship',
          character_count: 39,
          warnings: ['Название достигло лимита Twitch.'],
        },
      } as never)
    })

    await expect(test.service.previewTitle(DEFAULT_TITLE_SETTINGS)).resolves.toEqual({
      previewTitle: '#12 | 2400 | 3W-1L | Championship',
      characterCount: 39,
      warnings: ['Название достигло лимита Twitch.'],
    })
    expect(test.service.getView()).toBe(previousView)
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

  it('uses the shared streamer account registry routes', async () => {
    const test = harness()

    await test.service.addTitleAccount('#P0Y', 'Основной')
    await test.service.removeTitleAccount('#P0Y')

    expect(test.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/streamer/accounts',
        body: { tag: '#P0Y', alias: 'Основной' },
      }),
    )
    expect(test.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        path: '/api/streamer/accounts/%23P0Y',
      }),
    )
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
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
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

  it('projects authoritative readiness and unknown sections separately', async () => {
    const test = harness()
    await test.service.refresh()
    expect(await test.service.getReadiness()).toEqual({
      twitchConnected: true,
      accountsCount: 0,
      monitoring: true,
      captureConfigured: false,
      resultZonesConfigured: false,
      activeProfileId: null,
    })
    const original = test.request.getMockImplementation()
    if (original === undefined) throw new Error('Missing authenticated request mock')
    test.request.mockImplementation((input) =>
      input.path.endsWith('/auth/status')
        ? Promise.reject(new Error('twitch unavailable'))
        : original(input),
    )
    await test.service.refresh()
    expect(await test.service.getReadiness()).toMatchObject({
      twitchConnected: null,
      monitoring: true,
    })
  })

  it.each([true, false])(
    'derives result-zone readiness from the active profile fingerprint: %s',
    async (matches) => {
      const profileId = '00000000-0000-4000-8000-000000000001'
      const active = {
        profile: {
          profileId,
          configuration: { revision: 1, fingerprint: 'a'.repeat(64) },
        },
      }
      const result = {
        captureProfileId: profileId,
        captureConfigurationRevision: 1,
        captureConfigurationFingerprint: (matches ? 'a' : 'b').repeat(64),
      }
      const test = harness(undefined, active, result)
      await test.service.refresh()
      expect(await test.service.getReadiness()).toMatchObject({
        captureConfigured: true,
        resultZonesConfigured: matches,
        activeProfileId: profileId,
      })
    },
  )

  it('returns typed preview/domain failures, retaining warnings after committed mutations', async () => {
    const test = harness()
    vi.spyOn(test.service, 'previewTitle').mockResolvedValue({
      previewTitle: 'Real server title',
      characterCount: 17,
      warnings: ['Server warning'],
    })
    expect(
      await test.service.execute({
        action: 'title.preview',
        settings: DEFAULT_TITLE_SETTINGS,
      }),
    ).toMatchObject({
      ok: true,
      preview: { previewTitle: 'Real server title', warnings: ['Server warning'] },
    })
    expect(
      await test.service.execute({ action: 'chat.toggle', enabled: 'invalid' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(
      await test.service.execute({ action: 'accounts.add', tag: '#BAD', alias: 'Alias' }),
    ).toMatchObject({ ok: false, error: { code: 'ACCOUNT_TAG_INVALID' } })
    test.request.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        error: createApiError('ACCOUNT_NOT_FOUND', 'Account not found', false, 404),
      } as never),
    )
    expect(
      await test.service.execute({ action: 'accounts.remove', tag: '#P0Y' }),
    ).toMatchObject({ ok: false, error: { code: 'ACCOUNT_NOT_FOUND' } })
    vi.spyOn(test.service, 'refresh').mockRejectedValueOnce(new Error('refresh failed'))
    expect(
      await test.service.execute({ action: 'chat.toggle', enabled: true }),
    ).toMatchObject({ ok: true, warnings: ['REFRESH_FAILED'] })
  })

  it('re-enables using the authoritative existing alias via the deliberate upsert', async () => {
    const test = harness()
    const original = test.request.getMockImplementation()
    if (original === undefined) throw new Error('Missing authenticated request mock')
    test.request.mockImplementation(async (input) =>
      input.path.endsWith('/title/status')
        ? ({
            ok: true,
            status: 200,
            data: {
              success: true,
              settings: {},
              accounts: [
                { tag: 'P0Y', alias: 'Existing', name: 'Player', enabled: false },
              ],
            },
          } as never)
        : original(input),
    )
    expect(
      await test.service.execute({ action: 'accounts.reenable', tag: '#p0y' }),
    ).toMatchObject({ ok: true })
    expect(test.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/streamer/accounts',
        body: { tag: '#P0Y', alias: 'Existing' },
      }),
    )
    expect(
      await test.service.execute({ action: 'accounts.reenable', tag: '#JCU' }),
    ).toMatchObject({ ok: false, error: { code: 'ACCOUNT_NOT_FOUND' } })
  })

  it('applies immediately through existing title fields, never asserts an unverified Twitch success', async () => {
    const test = harness()
    expect(
      await test.service.execute({
        action: 'title.apply',
        settings: DEFAULT_TITLE_SETTINGS,
      }),
    ).toMatchObject({ ok: false, error: { code: 'TITLE_APPLY_UNAVAILABLE' } })
    const original = test.request.getMockImplementation()
    if (original === undefined) throw new Error('Missing authenticated request mock')
    test.request.mockImplementation(async (input) =>
      input.path.endsWith('/title/status')
        ? ({
            ok: true,
            status: 200,
            data: {
              success: true,
              settings: {},
              accounts: [],
              session: { total_wins: 1 },
            },
          } as never)
        : original(input),
    )
    await test.service.refresh()
    expect(
      await test.service.execute({
        action: 'title.apply',
        settings: DEFAULT_TITLE_SETTINGS,
      }),
    ).toMatchObject({
      ok: true,
      titleApplication: 'unconfirmed',
      warnings: ['TITLE_APPLICATION_UNCONFIRMED'],
    })
    expect(test.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/streamer/title/settings' }),
    )
    expect(
      test.request.mock.calls.find(
        ([input]) =>
          input.method === 'POST' && input.path === '/api/streamer/title/settings',
      )?.[0].body,
    ).toMatchObject({ enabled: true, paused: false })
    test.request.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        error: createApiError(
          'SERVER_ERROR',
          'Настройки сохранены, но Twitch не обновил название. Повторите попытку.',
          true,
          502,
        ),
      } as never),
    )
    expect(
      await test.service.execute({
        action: 'title.save',
        settings: DEFAULT_TITLE_SETTINGS,
      }),
    ).toMatchObject({
      ok: true,
      titleApplication: 'failed',
      warnings: ['TITLE_UPDATE_FAILED'],
    })
    test.request.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        error: createApiError('SERVER_ERROR', 'Bad gateway', true, 502),
      } as never),
    )
    expect(
      await test.service.execute({
        action: 'title.save',
        settings: DEFAULT_TITLE_SETTINGS,
      }),
    ).toMatchObject({ ok: false, error: { code: 'SERVER_ERROR' } })
  })

  it('fences both in-flight and queued mutations on auth change', async () => {
    const test = harness()
    const gate = Promise.withResolvers<unknown>()
    test.request.mockImplementationOnce(() => gate.promise as never)
    const first = test.service.execute({ action: 'chat.toggle', enabled: true })
    const second = test.service.execute({
      action: 'title.save',
      settings: DEFAULT_TITLE_SETTINGS,
    })
    await vi.waitFor(() => expect(test.request).toHaveBeenCalledOnce())
    test.changeAuth()
    gate.resolve({ ok: true, status: 200, data: { success: true } })
    expect(await first).toMatchObject({
      ok: false,
      error: { code: 'STREAMER_CANCELLED' },
    })
    expect(await second).toMatchObject({
      ok: false,
      error: { code: 'STREAMER_CANCELLED' },
    })
    expect(test.request).toHaveBeenCalledOnce()
  })
})

describe('narrow widget toggle ownership', () => {
  it('refreshes current settings before changing only enabled', async () => {
    const test = harness()
    const original = test.request.getMockImplementation()
    if (original === undefined) throw new Error('Missing authenticated request mock')
    test.request.mockImplementation(async (input) => {
      const result = await original(input)
      if (input.path.endsWith('/opponent-widget/status')) {
        return {
          ...result,
          data: {
            ...result.data,
            settings: {
              opponent_enabled: false,
              streamer_stats_enabled: false,
              preview_mode: true,
            },
          },
        } as never
      }
      return result
    })
    expect(
      await test.service.execute({ action: 'widget.enabled', enabled: true }),
    ).toMatchObject({ ok: true })
    const mutation = test.request.mock.calls.find(
      ([input]) =>
        input.method === 'PUT' && input.path === '/api/streamer/opponent-widget/settings',
    )
    expect(mutation?.[0].body).toMatchObject({
      enabled: true,
      opponent_enabled: false,
      streamer_stats_enabled: false,
      preview_mode: true,
    })
  })

  it('does not write another auth generation after an awaited preflight', async () => {
    const test = harness()
    const gate = Promise.withResolvers<unknown>()
    test.request.mockImplementationOnce(() => gate.promise as never)
    const pending = test.service.execute({ action: 'widget.enabled', enabled: true })
    await vi.waitFor(() => expect(test.request).toHaveBeenCalled())
    test.changeAuth()
    gate.resolve({ ok: true, status: 200, data: { success: true } })
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'STREAMER_CANCELLED' },
    })
    expect(
      test.request.mock.calls.filter(([input]) => input.method !== 'GET'),
    ).toHaveLength(0)
  })
})

describe('review regression stable title failure receipts', () => {
  it('#14 accepts the stable server code without relying on localized wording', async () => {
    const test = harness()
    const client = new ApiClient(
      { apiUrl: 'https://example.test' } as never,
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'TITLE_SAVED_APPLY_FAILED',
            detail: 'Wording changed',
          }),
          { status: 502 },
        ),
      ),
      { debug: vi.fn(), warn: vi.fn() },
    )
    const response = await client.request({
      method: 'POST',
      path: '/api/streamer/title/settings',
      schema: z.object({ success: z.literal(true) }).loose(),
    })
    test.request.mockImplementationOnce(() => Promise.resolve(response as never))
    expect(
      await test.service.execute({
        action: 'title.save',
        settings: DEFAULT_TITLE_SETTINGS,
      }),
    ).toMatchObject({
      ok: true,
      titleApplication: 'failed',
      warnings: ['TITLE_UPDATE_FAILED'],
    })
  })
})
