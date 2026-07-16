// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WIDGET_SETTINGS } from '../../../electron/main/infrastructure/widget-settings-repository'
import { WidgetApp } from './WidgetApp'

describe('WidgetApp', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'crToolsWidget', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockResolvedValue({
          settings: DEFAULT_WIDGET_SETTINGS,
          visible: true,
          result: {
            id: '29d970c1-fc4f-4bea-a767-8f108d3b8739',
            kind: 'player_found',
            timestamp: '2026-07-12T12:00:00.000Z',
            searchedNickname: 'Opponent',
            player: { name: 'Opponent', tag: '#TAG', rating: 2000, clan: 'Clan' },
            decks: [
              {
                label: 'PoL',
                cards: [
                  {
                    name: 'Knight',
                    level: 14,
                    evolutionLevel: 1,
                    hasImage: true,
                  },
                ],
              },
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
        }),
        getCardAsset: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
        updateSettings: vi
          .fn()
          .mockImplementation((settings) => Promise.resolve(settings)),
        hide: vi.fn(),
      }),
    })
  })

  it('renders player, deck fallback, and keyboard-focusable labeled controls', async () => {
    render(<WidgetApp />)
    expect(await screen.findByRole('heading', { name: 'Opponent' })).toBeVisible()
    expect(screen.getByText('Knight')).toBeVisible()
    expect(screen.getByText('K')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Поверх остальных окон' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('slider', { name: 'Прозрачность виджета' })).toBeVisible()
  })

  it('supports keyboard deck tabs and debounces opacity mutations', async () => {
    render(<WidgetApp />)
    await screen.findByRole('heading', { name: 'Opponent' })

    const firstTab = screen.getByRole('tab', { name: 'PoL' })
    firstTab.focus()
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Турнир' })).toHaveFocus()
    expect(screen.getByText('Archer')).toBeVisible()

    const opacity = screen.getByRole('slider', { name: 'Прозрачность виджета' })
    fireEvent.change(opacity, { target: { value: '80' } })
    fireEvent.change(opacity, { target: { value: '85' } })

    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(1),
    )
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ opacity: 0.85 }),
    )
    expect(await screen.findByText('Настройка сохранена')).toBeVisible()
  })

  it('shows mutation errors without hiding the current result', async () => {
    vi.mocked(window.crToolsWidget.updateSettings).mockRejectedValueOnce(
      new Error('failed'),
    )
    render(<WidgetApp />)
    await screen.findByRole('heading', { name: 'Opponent' })

    fireEvent.click(screen.getByRole('button', { name: 'Компактный режим' }))

    expect(await screen.findByText('Не удалось сохранить настройку.')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Opponent' })).toBeVisible()
  })

  it('serializes rapid compact and debounced opacity updates against latest settings', async () => {
    let serverView = await window.crToolsWidget.getView()
    vi.mocked(window.crToolsWidget.getView).mockClear()
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
    fireEvent.click(screen.getByRole('button', { name: 'Компактный режим' }))

    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(2),
    )
    expect(window.crToolsWidget.updateSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ compactMode: true }),
    )
    expect(window.crToolsWidget.updateSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ compactMode: true, opacity: 0.85 }),
    )
    expect(screen.getByText('Сохраняем настройку...')).toBeVisible()

    await act(async () => {
      resolveSecond()
      await secondMutation
    })
    expect(await screen.findByText('Настройка сохранена')).toBeVisible()
  })
})
