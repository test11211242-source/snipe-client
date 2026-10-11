// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { monitorViewFixture } from '../../../tests/monitor-fixtures'
import { installBridge, profilesFixture } from '../test/bridge'
import { installStream, ok } from '../test/streamerWorld'
import { sessionView, TRIGGER } from '../test/setupFake'
import { useMonitorController } from './monitor/useMonitorController'
import { useProfilesController } from './profiles/useProfilesController'
import { useTitleEditor } from './streamer/useTitleEditor'
import { StreamerContext } from './streamer/streamerContext'
import type {
  TitleBuilder,
  TitleCompileResult,
} from '../../../shared/contracts/title-builder'
import type { ProfileOutcome } from './profiles/useProfilesController'
import { useSetupSession } from './setup/useSetupSession'
import { useStreamerController } from './streamer/useStreamerController'
import type { CommandOutcome } from './streamer/useStreamerController'
import type { StreamerCommandResult } from '../../../shared/contracts/streamer-ipc'
import type { CaptureProfileCommandResult } from '../../../shared/contracts/capture-ipc'
import type { MonitorView } from '../../../shared/models/monitor'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('M6 review regressions', () => {
  it('#1 drains accepted commands after unmount and returns their real outcomes', async () => {
    const world = installStream()
    const gate = Promise.withResolvers<StreamerCommandResult>()
    world.fake.command.mockImplementationOnce(() => gate.promise)
    const { result, unmount } = renderHook(() => useStreamerController(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let first!: Promise<CommandOutcome>, second!: Promise<CommandOutcome>
    act(() => {
      first = result.current.command({ action: 'chat.toggle', enabled: true })
      second = result.current.command({ action: 'title.enabled', enabled: true })
    })
    unmount()
    gate.resolve(ok(world.fake.view))
    expect((await first).status).toBe('ok')
    expect((await second).status).toBe('ok')
    expect(world.fake.command.mock.calls.map(([command]) => command.action)).toEqual([
      'chat.toggle',
      'title.enabled',
    ])
  })

  it('#2 replaces a waiting command in place before overlapping later mutations', async () => {
    const world = installStream()
    const gate = Promise.withResolvers<StreamerCommandResult>()
    world.fake.command.mockImplementationOnce(() => gate.promise)
    const { result } = renderHook(() => useStreamerController(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const promises: Promise<CommandOutcome>[] = []
    act(() => {
      promises.push(result.current.command({ action: 'chat.toggle', enabled: true }))
      promises.push(
        result.current.command(
          { action: 'title.enabled', enabled: false },
          { key: 'title' },
        ),
      )
      promises.push(result.current.command({ action: 'title.paused', paused: true }))
      promises.push(
        result.current.command(
          { action: 'title.enabled', enabled: true },
          { key: 'title' },
        ),
      )
    })
    await act(async () => {
      gate.resolve(ok(world.fake.view))
      await Promise.all(promises)
    })
    expect(world.fake.command.mock.calls.map(([command]) => command.action)).toEqual([
      'chat.toggle',
      'title.enabled',
      'title.paused',
    ])
    expect(await promises[1]).toEqual({ status: 'superseded' })
  })

  it('#3 clears loading when a command supersedes an initial reload', async () => {
    const world = installStream()
    const gate = Promise.withResolvers<typeof world.fake.view>()
    world.bridge.crTools.setStreamerSectionActive.mockImplementationOnce(
      () => gate.promise,
    )
    const { result } = renderHook(() => useStreamerController(true))
    await waitFor(() =>
      expect(world.bridge.crTools.setStreamerSectionActive).toHaveBeenCalled(),
    )
    await act(async () => {
      await result.current.command({ action: 'chat.toggle', enabled: true })
    })
    await act(async () => {
      gate.resolve(world.fake.view)
      await gate.promise
    })
    expect(result.current.loading).toBe(false)
  })

  it('#4 maps only the explicit profile error code, never an English fragment', async () => {
    const bridge = installBridge()
    const { result } = renderHook(() => useProfilesController(vi.fn()))
    await waitFor(() => expect(result.current.value).not.toBeNull())
    bridge.crTools.renameCaptureProfile.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CAPTURE_PROFILE_NAME_CONFLICT' },
    })
    let outcome
    await act(async () => {
      outcome = await result.current.rename('profile', 'name')
    })
    expect(outcome).toEqual({
      ok: false,
      message: 'Профиль с таким названием уже есть. Выберите другое.',
    })
    bridge.crTools.renameCaptureProfile.mockRejectedValueOnce(
      new Error('Sign in; name already exists'),
    )
    await act(async () => {
      outcome = await result.current.rename('profile', 'name')
    })
    expect(outcome).toEqual({
      ok: false,
      message: 'Не удалось переименовать профиль. Название должно быть уникальным.',
    })
  })

  it('#5 never rolls a newer monitor push back with an older command response or poll', async () => {
    const bridge = installBridge({ monitor: monitorViewFixture({ seq: 1 }) })
    const gate = Promise.withResolvers<MonitorView>()
    bridge.crTools.startMonitor.mockImplementationOnce(() => gate.promise)
    const { result } = renderHook(useMonitorController)
    await waitFor(() => expect(result.current.value?.seq).toBe(1))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.start()
      bridge.push(
        monitorViewFixture({ seq: 3, state: 'WAITING_SOURCE', runIntent: true }),
      )
    })
    await act(async () => {
      gate.resolve(monitorViewFixture({ seq: 2, state: 'READY' }))
      await pending
    })
    expect(result.current.value?.state).toBe('WAITING_SOURCE')
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.value?.seq).toBe(3)
  })

  it('#6 prevents double retry while the first attempt is pending', async () => {
    const bridge = installBridge()
    const gate = Promise.withResolvers<MonitorView>()
    bridge.crTools.retryMonitorSearch.mockImplementationOnce(() => gate.promise)
    const { result } = renderHook(useMonitorController)
    let first!: Promise<void>
    act(() => {
      first = result.current.retrySearch('attempt')
      void result.current.retrySearch('attempt')
    })
    expect(bridge.crTools.retryMonitorSearch).toHaveBeenCalledOnce()
    expect(result.current.retrying).toBe(true)
    await act(async () => {
      gate.resolve(monitorViewFixture())
      await first
    })
    expect(result.current.retrying).toBe(false)
  })

  it('#10 ignores a same-session refresh older than an accepted command', async () => {
    const bridge = installBridge()
    const old = sessionView({ frameSize: null })
    const gate = Promise.withResolvers<typeof old>()
    bridge.crTools.setup.getSession.mockImplementationOnce(() => gate.promise)
    bridge.crTools.setup.setRegion.mockResolvedValueOnce(
      sessionView({ frameSize: null, generation: 2 }),
    )
    const { result } = renderHook(useSetupSession)
    await act(async () => {
      await result.current.adopt(old)
    })
    let refresh!: Promise<void>
    act(() => {
      refresh = result.current.refresh()
    })
    await act(async () => {
      await result.current.setRegion('trigger', TRIGGER)
    })
    await act(async () => {
      gate.resolve(old)
      await refresh
    })
    expect(result.current.latest()?.generation).toBe(2)
  })

  it('collection revision fences reject an older profile mutation after a newer reload', async () => {
    const bridge = installBridge()
    const gate = Promise.withResolvers<CaptureProfileCommandResult>()
    bridge.crTools.renameCaptureProfile.mockImplementationOnce(() => gate.promise)
    const { result } = renderHook(() => useProfilesController(vi.fn()))
    await waitFor(() => expect(result.current.value?.revision).toBe(1))
    let mutation!: Promise<ProfileOutcome>
    act(() => {
      mutation = result.current.rename('profile', 'name')
    })
    bridge.crTools.getCaptureProfiles.mockResolvedValue({
      ...profilesFixture(),
      revision: 3,
    })
    await act(async () => {
      await result.current.reload()
    })
    await act(async () => {
      gate.resolve({
        ok: true,
        profiles: { ...profilesFixture(), revision: 2 },
        monitor: monitorViewFixture(),
        capture: { configured: false, revision: null, sourceLabel: null },
      })
      await mutation
    })
    expect(result.current.value?.revision).toBe(3)
  })
  it('#17 keeps typed builder input when an older decompile resolves before compile', async () => {
    const world = installStream()
    const decompile = Promise.withResolvers<TitleBuilder>()
    const compile = Promise.withResolvers<TitleCompileResult>()
    world.api.decompileTitle.mockImplementationOnce(() => decompile.promise)
    world.api.compileTitle.mockImplementationOnce(() => compile.promise)
    const controller = {
      view: world.fake.view,
      readiness: world.fake.readiness,
      loading: false,
      loadFailed: false,
      pendingKeys: new Set<string>(),
      busy: false,
      reload: () => Promise.resolve(),
      command: vi.fn(),
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StreamerContext.Provider value={controller}>{children}</StreamerContext.Provider>
    )
    const { result } = renderHook(() => useTitleEditor(vi.fn()), { wrapper })
    const typed: TitleBuilder = { mode: 'raw', template: 'Мой текст' }
    act(() => result.current.setBuilder(typed))
    await act(async () => {
      decompile.resolve({ mode: 'preset', preset: 'full' })
      await decompile.promise
    })
    expect(result.current.builder).toEqual(typed)
    await act(async () => {
      compile.resolve({
        ok: true,
        settings: { ...world.fake.view.title.settings, prefixTemplate: 'Мой текст' },
      })
      await compile.promise
    })
    expect(result.current.draft.prefixTemplate).toBe('Мой текст')
  })
})
