import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MonitorResult } from '../../../shared/models/monitor'
import type { WidgetSettings } from '../../../shared/models/widget'
import { DEFAULT_WIDGET_SETTINGS } from '../infrastructure/widget-settings-repository'
import { WidgetController } from './widget-controller'

const found = (id: string): MonitorResult => ({
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
  let boundsListener:
    ((bounds: { x: number; y: number; width: number; height: number }) => void) | null =
    null
  const monitor = {
    getLatestResult: vi.fn(() => latest),
    subscribeResults: vi.fn((listener: (result: MonitorResult) => void) => {
      resultListener = listener
      return vi.fn()
    }),
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
    close: vi.fn(),
  }
  const controller = new WidgetController(monitor, repository as never, windows as never)
  return {
    controller,
    repository,
    windows,
    result: (value: MonitorResult) => {
      latest = value
      resultListener?.(value)
    },
    bounds: (value: { x: number; y: number; width: number; height: number }) =>
      boundsListener?.(value),
  }
}

afterEach(() => vi.useRealTimers())

describe('WidgetController', () => {
  it('auto-opens once for each new player result and ignores other results', async () => {
    const test = harness()
    await test.controller.start('user')
    const first = found('29d970c1-fc4f-4bea-a767-8f108d3b8739')
    test.result({
      id: '1b9da80f-e290-4ea6-ac83-ff2e212cdb2a',
      kind: 'player_not_found',
      timestamp: first.timestamp,
      searchMode: 'fast',
      deckMode: 'pol',
      searchedNickname: 'Ghost',
      message: 'not found',
    })
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

  it('does not auto-open when disabled and closes only widget on logout', async () => {
    const test = harness(false)
    await test.controller.start('user')
    test.result(found('29d970c1-fc4f-4bea-a767-8f108d3b8739'))
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

  it('snaps the window to canonical bounds when display mode changes', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    test.bounds({ x: 80, y: 90, width: 600, height: 700 })

    const deck = await test.controller.updateSettings({ displayMode: 'deck' })
    expect(deck).toMatchObject({
      displayMode: 'deck',
      bounds: { x: 80, y: 90, width: 360, height: 300 },
    })
    expect(test.windows.applyWidgetSettings).toHaveBeenLastCalledWith(deck)

    const detailed = await test.controller.updateSettings({ displayMode: 'detailed' })
    expect(detailed).toMatchObject({
      displayMode: 'detailed',
      bounds: { x: 80, y: 90, width: 420, height: 360 },
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
})
