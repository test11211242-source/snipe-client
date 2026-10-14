import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MonitorResultSchema,
  type MonitorResult,
  type MonitorView,
} from '../../../shared/models/monitor'
import type { WidgetSettings, WidgetView } from '../../../shared/models/widget'
import { selectOverlayModel } from '../../../renderer/src/widget/overlayModel'
import { DEFAULT_WIDGET_SETTINGS } from '../infrastructure/widget-settings-repository'
import { WidgetController } from './widget-controller'
import { monitorViewFixture } from '../../../tests/monitor-fixtures'

const found = (id: string): MonitorResult =>
  MonitorResultSchema.parse({
    id,
    kind: 'player_found',
    timestamp: '2026-07-12T12:00:00.000Z',
    searchMode: 'fast',
    deckMode: 'pol',
    searchedNickname: 'Player',
    player: { name: 'Player', tag: '#TAG', rating: 2000, clan: 'Clan' },
    decks: [
      {
        label: 'PoL',
        cards: [
          {
            name: 'Knight',
            level: 14,
            evolutionLevel: 1,
            iconUrl: 'https://api-assets.clashroyale.com/card.png',
          },
        ],
      },
    ],
  })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function harness(autoOpen = true) {
  let latest: MonitorResult | null = null
  let resultListener: ((result: MonitorResult) => void) | null = null
  let viewListener: ((view: MonitorView) => void) | null = null
  let boundsListener:
    ((bounds: { x: number; y: number; width: number; height: number }) => void) | null =
    null
  const monitor = {
    getLatestResult: vi.fn(() => latest),
    subscribeResults: vi.fn((listener: (result: MonitorResult) => void) => {
      resultListener = listener
      return vi.fn()
    }),
    subscribeViews: vi.fn((listener: (view: MonitorView) => void) => {
      viewListener = listener
      return vi.fn()
    }),
    getCurrentView: vi.fn(() => monitorViewFixture({ state: 'READY', runIntent: true })),
  }
  const repository = {
    load: vi.fn().mockResolvedValue({ ...DEFAULT_WIDGET_SETTINGS, autoOpen }),
    save: vi.fn((_userId, settings) => Promise.resolve(settings)),
  }
  const windows = {
    onWidgetBoundsChanged: vi.fn(
      (
        listener: (bounds: {
          x: number
          y: number
          width: number
          height: number
        }) => void,
      ) => {
        boundsListener = listener
        return vi.fn()
      },
    ),
    ensureWidgetWindow: vi.fn().mockResolvedValue(undefined),
    applyWidgetSettings: vi.fn(),
    showWidget: vi.fn(),
    showWidgetInactive: vi.fn(),
    hideWidget: vi.fn(),
    isWidgetVisible: vi.fn().mockReturnValue(false),
    sendToRenderer: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  }
  const controller = new WidgetController(monitor, repository as never, windows as never)
  return {
    controller,
    monitor,
    repository,
    windows,
    result: (value: MonitorResult) => {
      latest = value
      resultListener?.(value)
    },
    bounds: (value: { x: number; y: number; width: number; height: number }) =>
      boundsListener?.(value),
    view: (value: MonitorView) => {
      monitor.getCurrentView.mockReturnValue(value)
      viewListener?.(value)
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('WidgetController', () => {
  it.each([
    { alwaysOnTop: true, locked: false, compactMode: false },
    { alwaysOnTop: true, locked: true, compactMode: false },
    { alwaysOnTop: true, locked: true, compactMode: true },
    { alwaysOnTop: false, locked: false, compactMode: true },
  ])('hides without changing pin/lock/compact settings: %j', async (patch) => {
    const test = harness()
    await test.controller.start('user')
    await test.controller.updateSettings(patch)
    test.windows.isWidgetVisible.mockReturnValue(true)
    test.windows.hideWidget.mockImplementation(() => {
      test.windows.isWidgetVisible.mockReturnValue(false)
    })
    const before = test.controller.getView().settings
    const result = test.controller.hide()
    expect(result.visible).toBe(false)
    expect(result.settings).toEqual(before)
    expect(test.windows.hideWidget).toHaveBeenCalledOnce()
    expect(test.windows.showWidget).not.toHaveBeenCalled()
    expect(test.windows.showWidgetInactive).not.toHaveBeenCalled()
  })

  it('pushes width-derived scale immediately and dedupes content height feedback', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    await test.controller.updateSettings({ compactMode: true })
    test.windows.sendToRenderer.mockClear()
    test.bounds({ x: 10, y: 20, width: 240, height: 160 })
    expect(test.windows.sendToRenderer).toHaveBeenLastCalledWith(
      'widget',
      'widget:view-changed',
      expect.objectContaining({ scale: 0.86 }),
    )
    await test.controller.updateSettings({ contentHeight: 210 })
    const count = test.repository.save.mock.calls.length
    await test.controller.updateSettings({ contentHeight: 210 })
    expect(test.repository.save).toHaveBeenCalledTimes(count)
    expect(test.controller.getView().settings.compactWidth).toBe(240)
    await test.controller.stop()
  })
  it('auto-opens once for each new player result and ignores other results', async () => {
    const test = harness()
    await test.controller.start('user')
    const first = found('29d970c1-fc4f-4bea-a767-8f108d3b8739')
    test.result(
      MonitorResultSchema.parse({
        id: '1b9da80f-e290-4ea6-ac83-ff2e212cdb2a',
        kind: 'player_not_found',
        timestamp: first.timestamp,
        searchMode: 'fast',
        deckMode: 'pol',
        searchedNickname: 'Ghost',
        message: 'not found',
      }),
    )
    test.result(first)
    test.result(first)
    await vi.waitFor(() =>
      expect(test.windows.showWidgetInactive).toHaveBeenCalledTimes(1),
    )
    test.result(found('39d970c1-fc4f-4bea-a767-8f108d3b8739'))
    await vi.waitFor(() =>
      expect(test.windows.showWidgetInactive).toHaveBeenCalledTimes(2),
    )
  })

  it('projects the standalone reprocessed marker without private capture data', async () => {
    const test = harness()
    await test.controller.start('user')
    test.result({ ...found('39d970c1-fc4f-4bea-a767-8f108d3b8739'), reprocessed: true })
    expect(test.controller.getView().result).toMatchObject({ reprocessed: true })
  })

  it('does not auto-open when disabled and closes only widget on logout', async () => {
    const test = harness(false)
    await test.controller.start('user')
    test.result(found('29d970c1-fc4f-4bea-a767-8f108d3b8739'))
    expect(test.windows.sendToRenderer).toHaveBeenCalledWith(
      'widget',
      'widget:view-changed',
      test.controller.getView(),
    )
    expect(test.windows.showWidget).not.toHaveBeenCalled()
    expect(test.windows.showWidgetInactive).not.toHaveBeenCalled()
    await test.controller.stop('auth-transition')
    expect(test.windows.close).toHaveBeenCalledWith('widget', 'auth-transition')
  })

  it('focuses a manual show instead of using passive auto-open', async () => {
    const test = harness()
    await test.controller.start('user')
    await test.controller.show()
    expect(test.windows.showWidget).toHaveBeenCalledOnce()
    expect(test.windows.showWidgetInactive).not.toHaveBeenCalled()
  })

  it('waits for window load before showing and retries a failed auto-open id', async () => {
    const test = harness()
    await test.controller.start('user')
    const opening = deferred()
    test.windows.ensureWidgetWindow.mockReturnValueOnce(opening.promise)
    const manual = test.controller.show()
    await Promise.resolve()
    expect(test.windows.showWidget).not.toHaveBeenCalled()
    opening.resolve()
    await manual
    expect(test.windows.showWidget).toHaveBeenCalledOnce()

    const result = found('29d970c1-fc4f-4bea-a767-8f108d3b8739')
    test.windows.ensureWidgetWindow.mockRejectedValueOnce(new Error('load failed'))
    test.result(result)
    await vi.waitFor(() =>
      expect(test.windows.ensureWidgetWindow).toHaveBeenCalledTimes(2),
    )
    expect(test.windows.showWidgetInactive).not.toHaveBeenCalled()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    test.result(result)
    await vi.waitFor(() => expect(test.windows.showWidgetInactive).toHaveBeenCalledOnce())
  })

  it('applies settings and debounces persisted user bounds', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    const updated = { ...DEFAULT_WIDGET_SETTINGS, locked: true, opacity: 0.75 }
    await test.controller.updateSettings({ locked: true, opacity: 0.75 })
    expect(test.windows.applyWidgetSettings).toHaveBeenCalledWith(updated)

    test.bounds({ x: 10, y: 20, width: 500, height: 600 })
    test.bounds({ x: 11, y: 21, width: 510, height: 610 })
    expect(test.repository.save).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(test.repository.save).toHaveBeenCalledTimes(2)
    expect(test.repository.save).toHaveBeenLastCalledWith(
      'user',
      expect.objectContaining({
        bounds: { x: 11, y: 21, width: 510, height: 610 },
      }),
    )
  })

  it('switches to compact width and restores the resized normal width', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    test.bounds({ x: 80, y: 90, width: 600, height: 700 })

    const deck = await test.controller.updateSettings({
      compactMode: true,
      displayMode: 'deck',
    })
    expect(deck).toMatchObject({
      displayMode: 'deck',
      compactMode: true,
      bounds: { x: 80, y: 90, width: 300, height: 700 },
    })
    expect(test.windows.applyWidgetSettings).toHaveBeenLastCalledWith(deck)

    const detailed = await test.controller.updateSettings({
      compactMode: false,
      displayMode: 'detailed',
    })
    expect(detailed).toMatchObject({
      displayMode: 'detailed',
      compactMode: false,
      bounds: { x: 80, y: 90, width: 600, height: 700 },
    })
  })

  it('preserves native bounds that change while a settings patch is saving', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    let releaseSave!: () => void
    test.repository.save.mockImplementationOnce(
      (userId, settings: WidgetSettings) =>
        new Promise((resolve) => {
          expect(userId).toBe('user')
          releaseSave = () => resolve(settings)
        }),
    )

    const update = test.controller.updateSettings({ locked: true })
    await vi.waitFor(() => expect(test.repository.save).toHaveBeenCalledOnce())
    test.bounds({ x: 44, y: 55, width: 510, height: 610 })
    releaseSave()

    await expect(update).resolves.toMatchObject({
      locked: true,
      bounds: { x: 44, y: 55, width: 510, height: 610 },
    })
    expect(test.windows.applyWidgetSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        locked: true,
        bounds: { x: 44, y: 55, width: 510, height: 610 },
      }),
    )

    await vi.advanceTimersByTimeAsync(300)
    expect(test.repository.save).toHaveBeenLastCalledWith(
      'user',
      expect.objectContaining({
        locked: true,
        bounds: { x: 44, y: 55, width: 510, height: 610 },
      }),
    )
  })

  it('does not bounce a width drag back when an earlier content-height save resolves', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    const gate = Promise.withResolvers<WidgetSettings>()
    test.repository.save.mockReturnValueOnce(gate.promise)
    const update = test.controller.updateSettings({ contentHeight: 300 })
    await vi.waitFor(() => expect(test.repository.save).toHaveBeenCalledOnce())
    test.bounds({ x: 10, y: 20, width: 480, height: 360 })
    gate.resolve({
      ...DEFAULT_WIDGET_SETTINGS,
      bounds: { ...DEFAULT_WIDGET_SETTINGS.bounds, height: 300 },
    })
    await expect(update).resolves.toMatchObject({
      normalWidth: 480,
      bounds: { x: 10, y: 20, width: 480, height: 300 },
    })
    await test.controller.updateSettings({ contentHeight: 300 })
    expect(test.repository.save).toHaveBeenCalledOnce()
    await test.controller.stop()
  })

  it('rejects renderer-supplied bounds even when other patch fields are valid', async () => {
    const test = harness()
    await test.controller.start('user')

    await expect(
      test.controller.updateSettings({
        locked: true,
        bounds: { x: 1, y: 2, width: 500, height: 500 },
      } as never),
    ).rejects.toThrow()
    expect(test.repository.save).not.toHaveBeenCalled()
  })

  it('ignores bounds below the persisted schema minimum', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    expect(() => test.bounds({ x: 0, y: 0, width: 200, height: 120 })).not.toThrow()
    await vi.advanceTimersByTimeAsync(300)
    expect(test.repository.save).not.toHaveBeenCalled()
  })

  it('projects card availability without exposing retained URLs', async () => {
    const test = harness()
    await test.controller.start('user')
    const result = found('29d970c1-fc4f-4bea-a767-8f108d3b8739')
    test.result(result)
    const serialized = JSON.stringify(test.controller.getView())
    expect(serialized).not.toContain('api-assets')
    expect(serialized).not.toContain('iconUrl')
  })

  it('does not reopen the widget when an in-flight show finishes after logout', async () => {
    const test = harness()
    await test.controller.start('user')
    const opening = deferred()
    test.windows.ensureWidgetWindow.mockReturnValueOnce(opening.promise)

    const show = test.controller.show()
    await Promise.resolve()
    const stop = test.controller.stop('auth-transition')
    opening.resolve()

    await expect(show).rejects.toMatchObject({ code: 'WIDGET_CANCELLED' })
    await stop
    expect(test.windows.showWidget).not.toHaveBeenCalled()
    expect(test.windows.showWidgetInactive).not.toHaveBeenCalled()
    expect(test.windows.close).toHaveBeenCalledWith('widget', 'auth-transition')
  })

  it('persists bounded content height, retains mode widths and coalesces unchanged observer feedback', async () => {
    const test = harness()
    await test.controller.start('user')
    const saved = await test.controller.updateSettings({ contentHeight: 120 })
    expect(saved.bounds.height).toBe(120)
    expect(saved).not.toHaveProperty('contentHeight')
    expect(saved.normalWidth).toBe(DEFAULT_WIDGET_SETTINGS.normalWidth)
    const saves = test.repository.save.mock.calls.length
    await test.controller.updateSettings({ contentHeight: 120 })
    expect(test.repository.save).toHaveBeenCalledTimes(saves)
    await expect(test.controller.updateSettings({ contentHeight: 79 })).rejects.toThrow()
    await expect(test.controller.updateSettings({ contentHeight: 721 })).rejects.toThrow()
    expect(test.windows.applyWidgetSettings).toHaveBeenCalledWith(saved)
  })
})

describe('approved review projection followup', () => {
  it('includes the public rebind instruction in the widget projection', async () => {
    const test = harness()
    await test.controller.start('user')
    test.monitor.getCurrentView.mockReturnValue(
      monitorViewFixture({
        state: 'FAILED',
        runIntent: false,
        error: {
          code: 'SOURCE_REBIND_REQUIRED',
          message: 'Выберите окно игры заново в профиле',
        },
      }),
    )
    expect(test.controller.getView()).toMatchObject({
      monitorError: {
        code: 'SOURCE_REBIND_REQUIRED',
        message: 'Выберите окно игры заново в профиле',
      },
    })
    await test.controller.stop()
  })
})

describe('source-loss retries', () => {
  it('keeps one stable waiting state through PREFLIGHT/STARTING retries, never the old deck', async () => {
    const test = harness(false)
    await test.controller.start('user')
    test.result(found('7f0b31d6-3c8f-4e4b-9e57-5f5bb6f3b4a1'))
    const lost = { code: 'CAPTURE_SOURCE_CLOSED', message: 'Окно игры закрыто' }
    // Returns the view pushed to the renderer for this monitor transition.
    const drive = (patch: Partial<MonitorView>): WidgetView => {
      test.windows.sendToRenderer.mockClear()
      test.view(monitorViewFixture({ runIntent: true, ...patch }))
      const sent = test.windows.sendToRenderer.mock.lastCall?.[2] as
        WidgetView | undefined
      if (sent === undefined) throw new Error('No widget view was published')
      expect(test.controller.getView()).toEqual(sent)
      return sent
    }

    expect(selectOverlayModel(drive({ state: 'READY' })).body.kind).toBe('found')
    // The game closes; the supervisor retries on its backoff ladder (and after a
    // worker auto-restart, which also enters WAITING_SOURCE).
    const cycle: Partial<MonitorView>[] = [
      { state: 'WAITING_SOURCE', error: lost },
      { state: 'PREFLIGHT', error: null },
      { state: 'WAITING_SOURCE', error: lost },
      { state: 'PREFLIGHT', error: null },
      { state: 'STARTING', error: null },
      { state: 'WAITING_SOURCE', error: lost },
      { state: 'PREFLIGHT', error: null },
    ]
    for (const patch of cycle) {
      const view = drive(patch)
      expect(view).toMatchObject({ monitorState: 'WAITING_SOURCE', monitorError: lost })
      expect(selectOverlayModel(view).body).toMatchObject({
        kind: 'message',
        title: 'Ждём окно игры',
      })
    }
    // Monitoring really resumed: the retained deck returns once.
    expect(drive({ state: 'READY', error: null }).monitorState).toBe('READY')
    // A user Start is not a recovery attempt: it projects as itself.
    drive({ state: 'STOPPING', runIntent: false })
    expect(drive({ state: 'PREFLIGHT' }).monitorState).toBe('PREFLIGHT')
    // Stop while waiting ends the latch.
    drive({ state: 'WAITING_SOURCE', error: lost })
    expect(drive({ state: 'STOPPING', runIntent: false }).monitorState).toBe('STOPPING')
    await test.controller.stop()
  })
})
