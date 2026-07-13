// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
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
            ],
          },
        }),
        getCardAsset: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
        updateSettings: vi.fn(),
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
})
