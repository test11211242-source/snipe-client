// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WIDGET_SETTINGS } from '../../../electron/main/infrastructure/widget-settings-repository'
import type { WidgetView } from '../../../shared/models/widget'
import { WidgetApp } from './WidgetApp'

const primaryCards = Array.from({ length: 8 }, (_, index) => ({
  name: index === 0 ? 'Knight' : `Card ${index + 1}`,
  level: 14,
  evolutionLevel: index === 0 ? 1 : null,
  hasImage: true,
}))

const widgetView: WidgetView = {
  settings: DEFAULT_WIDGET_SETTINGS,
  visible: true,
  result: {
    id: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
    kind: 'player_found',
    timestamp: '2026-07-12T12:00:00.000Z',
    searchedNickname: 'Opponent',
    player: { name: 'Opponent', tag: '#TAG', rating: 2000, clan: 'Clan' },
    decks: [
      { label: 'PoL', cards: primaryCards },
      {
        label: 'Турнир',
        cards: [
          {
            name: 'Archer',
            level: 13,
            evolutionLevel: null,
            hasImage: false,
          },
        ],
      },
    ],
  },
}

describe('WidgetApp', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'crToolsWidget', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockResolvedValue(widgetView),
        getCardAsset: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
        updateSettings: vi
          .fn()
          .mockImplementation((settings) => Promise.resolve(settings)),
        hide: vi.fn(),
      }),
    })
  })

  it('renders the default mode as an image-only 4x2 deck', async () => {
    render(<WidgetApp />)

    expect(await screen.findByRole('article', { name: 'Knight' })).toBeVisible()
    expect(screen.getAllByRole('article')).toHaveLength(8)
    expect(screen.queryByRole('heading', { name: 'Opponent' })).not.toBeInTheDocument()
    expect(screen.queryByText('Knight')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('slider', { name: 'Прозрачность виджета' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Открыть подробный режим' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Поверх остальных окон' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('supports mini deck tabs and restores metadata in detailed mode', async () => {
    render(<WidgetApp />)
    await screen.findByRole('article', { name: 'Knight' })

    const firstTab = screen.getByRole('tab', { name: 'Колода 1: PoL' })
    firstTab.focus()
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Колода 2: Турнир' })).toHaveFocus()
    expect(screen.getByRole('article', { name: 'Archer' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Открыть подробный режим' }))
    expect(await screen.findByRole('heading', { name: 'Opponent' })).toBeVisible()
    expect(screen.getByText('Archer')).toBeVisible()
    expect(screen.getByRole('slider', { name: 'Прозрачность виджета' })).toBeVisible()
  })

  it('does not add navigation chrome when only one deck is available', async () => {
    if (widgetView.result?.kind !== 'player_found') throw new Error('Fixture is invalid')
    vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
      ...widgetView,
      result: { ...widgetView.result, decks: widgetView.result.decks.slice(0, 1) },
    })

    render(<WidgetApp />)

    expect(await screen.findByRole('group', { name: 'Карты колоды' })).toBeVisible()
    expect(
      screen.queryByRole('tablist', { name: 'Выбор колоды' }),
    ).not.toBeInTheDocument()
  })

  it('shows mutation errors without hiding the current deck', async () => {
    vi.mocked(window.crToolsWidget.updateSettings).mockRejectedValueOnce(
      new Error('failed'),
    )
    render(<WidgetApp />)
    await screen.findByRole('article', { name: 'Knight' })

    fireEvent.click(screen.getByRole('button', { name: 'Открыть подробный режим' }))

    expect(await screen.findByText('Не удалось сохранить настройку.')).toBeVisible()
    expect(screen.getByRole('article', { name: 'Knight' })).toBeVisible()
  })

  it('serializes rapid mode and debounced opacity updates against latest settings', async () => {
    let serverView: WidgetView = {
      ...widgetView,
      settings: {
        ...widgetView.settings,
        displayMode: 'detailed',
        bounds: { x: null, y: null, width: 420, height: 560 },
      },
    }
    vi.mocked(window.crToolsWidget.getView).mockImplementation(() =>
      Promise.resolve(serverView),
    )
    let mutationCount = 0
    let resolveSecond: () => void = () => {
      throw new Error('Second mutation was not initialized')
    }
    const secondMutation = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })
    vi.mocked(window.crToolsWidget.updateSettings).mockImplementation((settings) => {
      mutationCount += 1
      if (mutationCount === 1) {
        serverView = { ...serverView, settings }
        return Promise.resolve(settings)
      }
      return secondMutation.then(() => {
        serverView = { ...serverView, settings }
        return settings
      })
    })

    render(<WidgetApp />)
    await screen.findByRole('heading', { name: 'Opponent' })
    const opacity = screen.getByRole('slider', { name: 'Прозрачность виджета' })
    fireEvent.change(opacity, { target: { value: '80' } })
    fireEvent.change(opacity, { target: { value: '85' } })
    fireEvent.click(screen.getByRole('button', { name: 'Показать только колоду' }))

    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(2),
    )
    expect(window.crToolsWidget.updateSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ displayMode: 'deck' }),
    )
    expect(window.crToolsWidget.updateSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ displayMode: 'deck', opacity: 0.85 }),
    )
    expect(screen.getByText('Сохраняем настройку...')).toBeVisible()

    await act(async () => {
      resolveSecond()
      await secondMutation
    })
    expect(await screen.findByText('Настройка сохранена')).toBeVisible()
  })
})
