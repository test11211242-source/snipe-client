import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MonitorResult } from '../../../shared/models/monitor'
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
    await vi.waitFor(() => expect(test.windows.showWidget).toHaveBeenCalledTimes(1))
    test.result(found('39d970c1-fc4f-4bea-a767-8f108d3b8739'))
    await vi.waitFor(() => expect(test.windows.showWidget).toHaveBeenCalledTimes(2))
  })

  it('does not auto-open when disabled and closes only widget on logout', async () => {
    const test = harness(false)
    await test.controller.start('user')
    test.result(found('29d970c1-fc4f-4bea-a767-8f108d3b8739'))
    expect(test.windows.showWidget).not.toHaveBeenCalled()
    await test.controller.stop('auth-transition')
    expect(test.windows.close).toHaveBeenCalledWith('widget', 'auth-transition')
  })

  it('applies settings and debounces persisted user bounds', async () => {
    vi.useFakeTimers()
    const test = harness()
    await test.controller.start('user')
    const updated = { ...DEFAULT_WIDGET_SETTINGS, locked: true, opacity: 0.75 }
    await test.controller.updateSettings(updated)
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
    expect(test.windows.close).toHaveBeenCalledWith('widget', 'auth-transition')
  })
})
