import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_TITLE_SETTINGS } from './streamer-adapters'
import { StreamerService } from './streamer-service'
import { createApiError } from '../../../shared/errors/api-error'
import { AccountMutationResultSchema } from '../../../shared/contracts/streamer-ipc'
import { ApiClient } from './api-client'
import { z } from 'zod'
import { predictionStatusFixture } from '../../../tests/prediction-fixtures'
import {
  DEFAULT_PREDICTION_SETTINGS,
  type PredictionStatus,
  type StreamerView,
} from '../../../shared/models/streamer'

import { ApplicationError } from '../../../shared/errors/application-error'

const REQUEST_ID = '6f1f7c2e-8a3b-4c7d-9e2f-0a1b2c3d4e5f'
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
) {
  let authGeneration = 1
  let activeMutations = 0
  let maxMutations = 0
  let predictionStatus = structuredClone(predictionStatusFixture)
  let predictionSettings = { ...DEFAULT_PREDICTION_SETTINGS }
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
      if (input.path.endsWith('/predictions/status'))
        return {
          ok: true as const,
          status: 200,
          data: predictionStatus,
        }
      if (input.path.endsWith('/predictions/settings'))
        return {
          ok: true as const,
          status: 200,
          data: predictionSettings,
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
  const predictions = {
    startLifecycle: vi.fn(),
    shutdown: vi.fn(),
    saveSettings: vi.fn((settings: typeof predictionSettings) => {
      predictionSettings = settings
      predictionStatus = { ...predictionStatus, enabled: settings.enabled }
      return Promise.resolve(predictionStatus)
    }),
    manualBattle: vi.fn().mockResolvedValue(predictionStatusFixture),
    cancel: vi.fn().mockResolvedValue(predictionStatusFixture),
  }
  const service = new StreamerService(
    { getView: () => userView, getContextGeneration: () => authGeneration } as never,
    { request } as never,
    {
      load: vi.fn().mockResolvedValue(null),
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
    predictions as never,
    shell,
    clipboard,
    () => new Date('2026-07-12T12:00:00.000Z'),
  )
  return {
    service,
    request,
    shell,
    predictions,
    setPredictionStatus: (status: PredictionStatus) => {
      predictionStatus = status
    },
    clipboard,
    maxMutations: () => maxMutations,
    changeAuth: () => ++authGeneration,
  }
}

describe('prediction settings and manual settlement', () => {
  it('loads settings from the server with the 30-second default', async () => {
    const test = harness()
    const view = await test.service.refresh()
    expect(view.predictions.settings).toEqual(DEFAULT_PREDICTION_SETTINGS)
    expect(test.request.mock.calls.map(([input]) => input.path)).toContain(
      '/api/streamer/predictions/settings',
    )
    expect(view.predictions.settings.votingSeconds).toBe(30)
  })

  it('saves new settings without starting or stopping the monitor', async () => {
    const test = harness()
    const settings = {
      ...DEFAULT_PREDICTION_SETTINGS,
      enabled: false,
      mode: 'streak' as const,
    }
    const result = await test.service.execute({
      action: 'predictions.settings.save',
      settings,
    })
    expect(result.ok).toBe(true)
    expect(test.predictions.saveSettings).toHaveBeenCalledWith(settings)
    expect(test.service.getView().predictions.settings).toEqual(settings)
    expect(test.service.getView().predictions.enabled).toBe(false)
  })

  it.each(['win', 'loss', 'not_ranked'] as const)(
    'routes manual %s with the current prediction identity and request ID',
    async (outcome) => {
      const test = harness()
      const status = {
        ...predictionStatusFixture,
        stats: {
          resolved: 1,
          yes: outcome === 'win' ? 1 : 0,
          no: outcome === 'loss' ? 1 : 0,
          canceled: 0,
        },
      }
      test.setPredictionStatus(status)
      test.predictions.manualBattle.mockResolvedValue(status)
      const result = await test.service.execute({
        action: 'predictions.battle',
        predictionId: 71,
        outcome,
        requestId: REQUEST_ID,
      })
      expect(result.ok).toBe(true)
      expect(test.predictions.manualBattle).toHaveBeenCalledExactlyOnceWith(
        71,
        outcome,
        REQUEST_ID,
      )
      expect(test.service.getView().predictions.stats).toEqual(status.stats)
    },
  )

  it('rejects a manual battle without a UUID request ID before any request', async () => {
    const test = harness()
    for (const requestId of [undefined, '', 'press-1', 7])
      expect(
        await test.service.execute({
          action: 'predictions.battle',
          predictionId: 71,
          outcome: 'win',
          ...(requestId === undefined ? {} : { requestId }),
        }),
      ).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED', detail: null } })
    expect(test.predictions.manualBattle).not.toHaveBeenCalled()
    expect(test.request).not.toHaveBeenCalled()
  })

  it('requires confirmation before forwarding cancel', async () => {
    const test = harness()
    expect(
      (
        await test.service.execute({
          action: 'predictions.cancel',
          predictionId: 71,
        })
      ).ok,
    ).toBe(false)
    expect(test.predictions.cancel).not.toHaveBeenCalled()
    expect(
      (
        await test.service.execute({
          action: 'predictions.cancel',
          predictionId: 71,
          confirmed: true,
        })
      ).ok,
    ).toBe(true)
    expect(test.predictions.cancel).toHaveBeenCalledExactlyOnceWith(71)
  })

  it('rejects invalid streak ranges at the IPC boundary', async () => {
    const test = harness()
    const result = await test.service.execute({
      action: 'predictions.settings.save',
      settings: { ...DEFAULT_PREDICTION_SETTINGS, streakFrom: 6, streakTo: 2 },
    })
    expect(result.ok).toBe(false)
    expect(test.predictions.saveSettings).not.toHaveBeenCalled()
  })

  it('renders a server-side stop and restart without a local runtime gate', async () => {
    const test = harness()
    expect((await test.service.refresh()).predictions.enabled).toBe(true)
    test.setPredictionStatus({
      ...predictionStatusFixture,
      enabled: false,
      phase: 'disabled',
    })
    expect((await test.service.refresh()).predictions.enabled).toBe(false)
    test.setPredictionStatus(predictionStatusFixture)
    expect((await test.service.refresh()).predictions.enabled).toBe(true)
  })

  it('never applies a manual response from an old auth generation', async () => {
    const test = harness()
    const gate = Promise.withResolvers<PredictionStatus>()
    test.predictions.manualBattle.mockReturnValueOnce(gate.promise)
    const before = test.service.getView().predictions
    const pending = test.service.execute({
      action: 'predictions.battle',
      predictionId: 71,
      outcome: 'win',
      requestId: REQUEST_ID,
    })
    await vi.waitFor(() => expect(test.predictions.manualBattle).toHaveBeenCalled())
    test.changeAuth()
    gate.resolve({
      ...predictionStatusFixture,
      stats: { resolved: 1, yes: 1, no: 0, canceled: 0 },
    })
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'STREAMER_CANCELLED' },
    })
    expect(test.service.getView().predictions).toEqual(before)
  })
})

describe('recovery after a failed prediction command', () => {
  const streak = (id: number, wins: number): PredictionStatus => ({
    ...predictionStatusFixture,
    live: true,
    phase: 'locked',
    prediction: {
      id,
      title: 'Выиграю 5 боёв подряд?',
      mode: 'streak',
      target: 5,
      wins,
      locksAt: '2026-07-12T12:00:30.000Z',
      hasBets: true,
    },
  })
  const battle = (outcome: 'win' | 'loss' | 'not_ranked' = 'win') => ({
    action: 'predictions.battle' as const,
    predictionId: 71,
    outcome,
    requestId: REQUEST_ID,
  })
  const statusReads = (request: {
    mock: { calls: [{ path: string }][]; invocationCallOrder: number[] }
  }): number[] =>
    request.mock.calls.flatMap(([input], index) =>
      input.path === '/api/streamer/predictions/status'
        ? [request.mock.invocationCallOrder[index] ?? 0]
        : [],
    )
  /** Lets every already-queued continuation run; no wall-clock wait. */
  const flushMicrotasks = async (): Promise<void> => {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
  }

  it.each([
    'NETWORK_UNAVAILABLE',
    'REQUEST_TIMEOUT',
    'SERVER_ERROR',
    'INVALID_RESPONSE',
    'VALIDATION_FAILED',
  ] as const)(
    'refreshes the status after %s and keeps the original error',
    async (code) => {
      const test = harness()
      test.setPredictionStatus(streak(71, 3))
      await test.service.refresh()
      // The press reached the server and was applied; only its response was lost.
      test.predictions.manualBattle.mockImplementationOnce(() => {
        test.setPredictionStatus(streak(71, 4))
        return Promise.reject(new ApplicationError(code, 'lost response'))
      })
      const before = statusReads(test.request).length
      const result = await test.service.execute(battle())
      expect(result).toEqual({ ok: false, error: { code, detail: null } })
      expect(test.predictions.manualBattle).toHaveBeenCalledOnce()
      const after = statusReads(test.request)
      expect(after.length).toBe(before + 1)
      expect(after.at(-1)).toBeGreaterThan(
        test.predictions.manualBattle.mock.invocationCallOrder[0] ?? Infinity,
      )
      expect(test.service.getView().predictions.prediction).toMatchObject({
        id: 71,
        wins: 4,
      })
      expect(test.service.getView().refresh.errors).toEqual([])
    },
  )

  it('answers a failed manual command only after the status refresh finished', async () => {
    const test = harness()
    test.setPredictionStatus(streak(71, 3))
    await test.service.refresh()
    const original = test.request.getMockImplementation()
    if (original === undefined) throw new Error('Missing request fixture')
    const gate = Promise.withResolvers<void>()
    test.request.mockImplementation(async (input) => {
      if (input.path === '/api/streamer/predictions/status') await gate.promise
      return original(input)
    })
    test.predictions.manualBattle.mockImplementationOnce(() => {
      test.setPredictionStatus(streak(71, 4))
      return Promise.reject(new ApplicationError('REQUEST_TIMEOUT', 'lost response'))
    })
    let settled = false
    const pending = test.service.execute(battle()).finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(statusReads(test.request).length).toBe(2))
    await flushMicrotasks()
    expect(settled).toBe(false)
    expect(test.service.getView().predictions.prediction?.wins).toBe(3)
    gate.resolve()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'REQUEST_TIMEOUT' } })
    expect(test.service.getView().predictions.prediction?.wins).toBe(4)
  })

  it('keeps the original error and the last status when the refresh also fails', async () => {
    const test = harness()
    test.setPredictionStatus(streak(71, 3))
    await test.service.refresh()
    const original = test.request.getMockImplementation()
    if (original === undefined) throw new Error('Missing request fixture')
    test.request.mockImplementation(async (input) => {
      if (input.path === '/api/streamer/predictions/status')
        return {
          ok: false,
          error: createApiError('NETWORK_UNAVAILABLE', 'offline', true),
        } as never
      return original(input)
    })
    test.predictions.manualBattle.mockRejectedValueOnce(
      new ApplicationError('NETWORK_UNAVAILABLE', 'offline'),
    )
    expect(await test.service.execute(battle('not_ranked'))).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_UNAVAILABLE' },
    })
    const view = test.service.getView()
    expect(view.predictions.prediction).toMatchObject({ id: 71, wins: 3 })
    expect(view.refresh.errors.map((error) => error.section)).toContain('predictions')
  })

  it('refreshes after a stale (409) cancel so the new prediction is shown', async () => {
    const test = harness()
    test.setPredictionStatus(streak(71, 3))
    await test.service.refresh()
    test.predictions.cancel.mockImplementationOnce(() => {
      test.setPredictionStatus(streak(72, 0))
      return Promise.reject(new ApplicationError('VALIDATION_FAILED', 'stale'))
    })
    expect(
      await test.service.execute({
        action: 'predictions.cancel',
        predictionId: 71,
        confirmed: true,
      }),
    ).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED', detail: null } })
    expect(test.service.getView().predictions.prediction?.id).toBe(72)
  })

  it('an account switch before the failure arrives cancels the recovery', async () => {
    const test = harness()
    test.setPredictionStatus(streak(71, 3))
    await test.service.refresh()
    const before = test.service.getView().predictions
    const gate = Promise.withResolvers<PredictionStatus>()
    test.predictions.manualBattle.mockReturnValueOnce(gate.promise)
    const pending = test.service.execute(battle())
    await vi.waitFor(() => expect(test.predictions.manualBattle).toHaveBeenCalled())
    const reads = statusReads(test.request).length
    test.changeAuth()
    gate.reject(new ApplicationError('REQUEST_TIMEOUT', 'lost response'))
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'STREAMER_CANCELLED', detail: null },
    })
    expect(statusReads(test.request)).toHaveLength(reads)
    expect(test.service.getView().predictions).toEqual(before)
  })

  it('an account switch during the recovery refresh discards it', async () => {
    const test = harness()
    test.setPredictionStatus(streak(71, 3))
    await test.service.refresh()
    const original = test.request.getMockImplementation()
    if (original === undefined) throw new Error('Missing request fixture')
    const gate = Promise.withResolvers<void>()
    test.request.mockImplementation(async (input) => {
      if (input.path === '/api/streamer/predictions/status') await gate.promise
      return original(input)
    })
    test.predictions.manualBattle.mockImplementationOnce(() => {
      test.setPredictionStatus(streak(71, 4))
      return Promise.reject(new ApplicationError('REQUEST_TIMEOUT', 'lost response'))
    })
    const pending = test.service.execute(battle())
    await vi.waitFor(() => expect(statusReads(test.request).length).toBe(2))
    // The application controller stops the service on every account transition.
    test.changeAuth()
    await test.service.stop()
    gate.resolve()
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'STREAMER_CANCELLED', detail: null },
    })
    expect(test.service.getView().predictions.prediction).toBeNull()
  })

  it('does not mark a new account failed when an old recovery rejects after stop', async () => {
    const test = harness()
    test.setPredictionStatus(streak(71, 3))
    await test.service.refresh()
    const recovery = Promise.withResolvers<StreamerView>()
    const refresh = vi
      .spyOn(test.service, 'refresh')
      .mockReturnValueOnce(recovery.promise)
    test.predictions.manualBattle.mockRejectedValueOnce(
      new ApplicationError('REQUEST_TIMEOUT', 'lost response'),
    )
    const pending = test.service.execute(battle())
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    test.changeAuth()
    await test.service.stop()
    recovery.reject(new Error('stale recovery failed'))
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'STREAMER_CANCELLED' },
    })
    expect(test.service.getView().refresh.state).toBe('idle')
  })

  it('never retries a failed manual command by itself', async () => {
    const test = harness()
    test.predictions.manualBattle.mockRejectedValue(
      new ApplicationError('REQUEST_TIMEOUT', 'lost response'),
    )
    await test.service.execute(battle())
    await flushMicrotasks()
    expect(test.predictions.manualBattle).toHaveBeenCalledOnce()
  })
})

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
      predictionProfileReady: false,
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

  it('does not accept a full-frame profile even with saved result zones', async () => {
    const profileId = '00000000-0000-4000-8000-000000000001'
    const test = harness(undefined, {
      profile: {
        profileId,
        configuration: { calibration: { coordinateSpace: 'full_frame_normalized' } },
      },
    })
    await test.service.refresh()
    expect(await test.service.getReadiness()).toMatchObject({
      captureConfigured: true,
      predictionProfileReady: false,
      activeProfileId: profileId,
    })
  })

  it.each([0.43, 0.52])(
    'requires only own-battle game-relative layouts: %s',
    async (cy) => {
      const profileId = '00000000-0000-4000-8000-000000000001'
      const test = harness(undefined, {
        profile: {
          profileId,
          configuration: {
            calibration: {
              coordinateSpace: 'game_relative',
              layouts: [{ trigger: { kind: 'vs_edge_orientation', badge: { cy } } }],
            },
          },
        },
      })
      await test.service.refresh()
      expect(await test.service.getReadiness()).toMatchObject({
        predictionProfileReady: cy === 0.43,
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
