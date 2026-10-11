// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { UpdateView } from '../../../shared/models/update'
import { CaptureProfileNamePayloadSchema } from '../../../shared/contracts/capture-ipc'
import { installBridge, profilesFixture, updateIdle } from '../test/bridge'
import { installStream, mountStream, ok } from '../test/streamerWorld'
import { sourcesFixture } from '../test/setupFake'
import { useSourcePicker } from './setup/useSourcePicker'
import { useAuthUpdater } from '../auth/useAuthUpdater'
import { useConfirmedAction } from './streamer/useRunner'
import { StreamerContext } from './streamer/streamerContext'
import { useProfilesController } from './profiles/useProfilesController'
import { monitorViewFixture } from '../../../tests/monitor-fixtures'
import { Dialog, Menu, MenuItem } from '../ui'
import { WidgetPreview } from './streamer/WidgetPreview'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('M6 self-review regressions', () => {
  it('source picker deduplicates same-tick selections and consumes a preparation once', async () => {
    const bridge = installBridge()
    const sources = sourcesFixture()
    bridge.crTools.listCaptureSources.mockResolvedValue(sources)
    const gate = Promise.withResolvers<unknown>()
    bridge.crTools.prepareCaptureSource.mockImplementationOnce(() => gate.promise)
    const { result } = renderHook(useSourcePicker)
    await waitFor(() => expect(result.current.loading).toBe(false))
    const source = sources.sources[0]
    if (source === undefined) throw new Error('source fixture missing')
    let selecting!: Promise<void>
    act(() => {
      selecting = result.current.select(source)
      void result.current.select(source)
    })
    expect(bridge.crTools.prepareCaptureSource).toHaveBeenCalledOnce()
    const preparation = {
      sourceKey: source.sourceKey,
      revision: source.revision,
      preparationId: '00000000-0000-4000-8000-000000000020',
    }
    await act(async () => {
      gate.resolve({ ok: true, preparation })
      await selecting
    })
    act(() => {
      expect(result.current.take()).toEqual(preparation)
      expect(result.current.take()).toBeNull()
    })
  })

  it('auth updater rejects late initial and progress reads after command completion', async () => {
    const initial = Promise.withResolvers<UpdateView>()
    const progress = Promise.withResolvers<UpdateView>()
    const complete = Promise.withResolvers<UpdateView>()
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: {
        getUpdateView: vi
          .fn()
          .mockImplementationOnce(() => initial.promise)
          .mockImplementationOnce(() => progress.promise),
        downloadUpdate: vi.fn(() => complete.promise),
        cancelUpdate: vi.fn(),
        installUpdate: vi.fn(),
      },
    })
    const { result } = renderHook(useAuthUpdater)
    let downloading!: Promise<void>
    act(() => {
      downloading = result.current.run('download')
    })
    await act(async () => {
      complete.resolve({ ...updateIdle, state: 'READY' })
      await downloading
    })
    await act(async () => {
      initial.resolve(updateIdle)
      progress.resolve({ ...updateIdle, state: 'DOWNLOADING' })
      await Promise.all([initial.promise, progress.promise])
    })
    expect(result.current.view?.state).toBe('READY')
  })

  it('auth updater permits cancellation but drops the superseded download response', async () => {
    const gate = Promise.withResolvers<UpdateView>()
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: {
        getUpdateView: vi.fn().mockResolvedValue({ ...updateIdle, state: 'AVAILABLE' }),
        downloadUpdate: vi.fn(() => gate.promise),
        cancelUpdate: vi.fn().mockResolvedValue({ ...updateIdle, state: 'AVAILABLE' }),
        installUpdate: vi.fn(),
      },
    })
    const { result } = renderHook(useAuthUpdater)
    let download!: Promise<void>
    act(() => {
      download = result.current.run('download')
      void result.current.run('download')
    })
    expect(window.crToolsAuth.downloadUpdate).toHaveBeenCalledOnce()
    await act(async () => {
      await result.current.run('cancel')
    })
    await act(async () => {
      gate.resolve({ ...updateIdle, state: 'READY' })
      await download
    })
    expect(result.current.view?.state).toBe('AVAILABLE')
    expect(result.current.pending).toBeNull()
  })

  it('confirmed actions cannot submit twice or dismiss while pending', async () => {
    const world = installStream()
    const gate = Promise.withResolvers<unknown>()
    const command = vi.fn(() => gate.promise)
    const controller = {
      view: world.fake.view,
      readiness: world.fake.readiness,
      loading: false,
      loadFailed: false,
      pendingKeys: new Set<string>(),
      busy: false,
      reload: vi.fn(),
      command,
    } as never
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StreamerContext.Provider value={controller}>{children}</StreamerContext.Provider>
    )
    const { result } = renderHook(
      () => useConfirmedAction({ action: 'twitch.disconnect', confirmed: true }),
      { wrapper },
    )
    act(() => result.current.ask())
    act(() => {
      result.current.confirm()
      result.current.confirm()
      result.current.cancel()
    })
    expect(command).toHaveBeenCalledOnce()
    expect(result.current.open).toBe(true)
    await act(async () => {
      gate.resolve({ status: 'ok', result: ok(world.fake.view) })
      await gate.promise
    })
    expect(result.current.open).toBe(false)
  })

  it('overlay Stepper advances the visible draft while previous saves are pending', async () => {
    const world = mountStream({ name: 'settings', section: 'overlay' })
    const gate = Promise.withResolvers<unknown>()
    world.bridge.crTools.updateWidgetSettings.mockImplementationOnce(() => gate.promise)
    const group = await screen.findByRole('group', { name: 'Ширина окна' })
    fireEvent.click(within(group).getByRole('button', { name: 'Увеличить' }))
    fireEvent.click(within(group).getByRole('button', { name: 'Увеличить' }))
    expect(within(group).getByRole('spinbutton')).toHaveAttribute('aria-valuenow', '400')
    await act(async () => {
      gate.resolve({ ...world.fake.widget.settings, normalWidth: 380 })
      await gate.promise
    })
    await waitFor(() =>
      expect(world.bridge.crTools.updateWidgetSettings).toHaveBeenLastCalledWith({
        normalWidth: 400,
      }),
    )
    expect(within(group).getByRole('spinbutton')).toHaveAttribute('aria-valuenow', '400')
  })

  it('profile commands use the latest accepted revision even through an old callback', async () => {
    const bridge = installBridge()
    const { result } = renderHook(() => useProfilesController(vi.fn()))
    await waitFor(() => expect(result.current.value?.revision).toBe(1))
    const rename = result.current.rename
    bridge.crTools.renameCaptureProfile.mockImplementation(
      ({ expectedRevision }: { expectedRevision: number }) =>
        Promise.resolve({
          ok: true,
          profiles: { ...profilesFixture(), revision: expectedRevision + 1 },
          monitor: monitorViewFixture(),
          capture: { configured: false, revision: null, sourceLabel: null },
        }),
    )
    await act(async () => {
      await rename('00000000-0000-4000-8000-000000000001', 'first')
      await rename('00000000-0000-4000-8000-000000000001', 'second')
    })
    expect(
      bridge.crTools.renameCaptureProfile.mock.calls.map(
        ([payload]) => CaptureProfileNamePayloadSchema.parse(payload).expectedRevision,
      ),
    ).toEqual([1, 2])
  })

  it('Escape closes a portalled menu before its containing modal', () => {
    const onClose = vi.fn()
    render(
      <Dialog title="Профили" onClose={onClose} footer={null}>
        <Menu label="Действия" trigger={({ props }) => <button {...props}>Меню</button>}>
          <MenuItem onSelect={vi.fn()}>Действие</MenuItem>
        </Menu>
      </Dialog>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Меню' }))
    expect(screen.getByRole('menu')).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Меню' })).toHaveFocus()
  })

  it('only the topmost modal handles Escape', () => {
    const outer = vi.fn(),
      inner = vi.fn()
    render(
      <>
        <Dialog title="Внешний" onClose={outer} footer={null}>
          Внешний
        </Dialog>
        <Dialog title="Внутренний" onClose={inner} footer={null}>
          Внутренний
        </Dialog>
      </>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
  })

  it('#7 recovers preview readiness when loading finishes after the timeout', async () => {
    vi.useFakeTimers()
    render(
      <WidgetPreview
        title="Предпросмотр"
        url="https://api.artcsworld.xyz/opponent-widget?mock=1"
        width={360}
        height={240}
        dimmed={false}
      />,
    )
    await act(async () => vi.advanceTimersByTimeAsync(16_000))
    expect(screen.getByRole('alert')).toBeVisible()
    fireEvent.load(screen.getByTitle('Предпросмотр'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTitle('Предпросмотр').style.visibility).toBe('visible')
  })
})
