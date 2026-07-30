// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WIDGET_SETTINGS } from '../../../electron/main/infrastructure/widget-settings-repository'
import type { WidgetView } from '../../../shared/models/widget'
import { WidgetApp } from './WidgetApp'

const primaryCard = {
  name: 'Knight',
  level: 14,
  evolutionLevel: 1,
  hasImage: true,
}

const primaryCards = [
  primaryCard,
  ...Array.from({ length: 7 }, (_, index) => ({
    name: `Card ${index + 2}`,
    level: 14,
    evolutionLevel: null,
    hasImage: true,
  })),
]

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

async function loadWidgetWithFakeTimers(): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(0))
}

describe('WidgetApp', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'crToolsWidget', {
      configurable: true,
      value: Object.freeze({
        rendererReady: vi.fn().mockResolvedValue(undefined),
        getView: vi.fn().mockResolvedValue(widgetView),
        getCardAsset: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
        updateSettings: vi
          .fn()
          .mockImplementation((patch) =>
            Promise.resolve({ ...widgetView.settings, ...patch }),
          ),
        hide: vi.fn(),
      }),
    })
  })

  afterEach(() => vi.useRealTimers())

  it('renders the V1 full mode as a direct image-only 4x2 grid', async () => {
    const { container } = render(<WidgetApp />)

    expect(await screen.findByRole('heading', { name: 'Opponent' })).toBeVisible()
    expect(screen.getByLabelText('Рейтинг 2000')).toBeVisible()
    expect(screen.getAllByRole('article')).toHaveLength(8)
    expect(screen.queryByText('Knight')).not.toBeInTheDocument()
    expect(screen.getByText('PoL')).toBeVisible()
    expect(screen.getByText('8 / 8')).toBeVisible()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Компактный вид' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByLabelText('Управление виджетом')).toHaveClass('widget-controls')
    expect(screen.getByTitle('Перетащить виджет')).toHaveClass('widget-drag-handle')
    expect(window.crToolsWidget.rendererReady).toHaveBeenCalledOnce()

    const shell = container.querySelector('.widget-shell')
    const grid = container.querySelector('.card-grid')
    expect(shell).toHaveAttribute('data-mode', 'full')
    expect(grid?.children).toHaveLength(8)
    expect(
      [...Array.from(grid?.children ?? [])].every((card) => card.matches('.deck-card')),
    ).toBe(true)
    expect(container.querySelector('.card-copy')).not.toBeInTheDocument()
  })

  it('completes settings mutations under the real StrictMode lifecycle', async () => {
    render(
      <StrictMode>
        <WidgetApp />
      </StrictMode>,
    )
    const pin = await screen.findByRole('button', {
      name: 'Открепить от переднего плана',
    })

    fireEvent.click(pin)

    await waitFor(() => expect(window.crToolsWidget.updateSettings).toHaveBeenCalled())
    await waitFor(() => expect(pin).not.toBeDisabled())
    expect(screen.queryByText('Сохраняем настройку...')).not.toBeInTheDocument()
  })

  it('switches decks with compact dots and hides only the footer in compact mode', async () => {
    const { container } = render(<WidgetApp />)
    await screen.findByRole('article', { name: 'Knight' })

    const firstTab = screen.getByRole('tab', { name: 'Колода 1: PoL' })
    firstTab.focus()
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Колода 2: Турнир' })).toHaveFocus()
    expect(screen.getByRole('article', { name: 'Archer' })).toBeVisible()
    expect(screen.getByText('Турнир')).toBeVisible()
    expect(screen.getByText('1 / 8')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид' }))
    await waitFor(() =>
      expect(container.querySelector('.widget-shell')).toHaveAttribute(
        'data-mode',
        'compact',
      ),
    )
    expect(screen.getByRole('heading', { name: 'Opponent' })).toBeVisible()
    expect(screen.getByRole('article', { name: 'Archer' })).toBeVisible()
    expect(screen.queryByText('1 / 8')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Полный вид' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('does not add deck navigation chrome when only one deck is available', async () => {
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

  it('shows mutation errors without hiding or replacing the current deck', async () => {
    vi.mocked(window.crToolsWidget.updateSettings).mockRejectedValueOnce(
      new Error('failed'),
    )
    render(<WidgetApp />)
    await screen.findByRole('article', { name: 'Knight' })

    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид' }))

    expect(await screen.findByText('Не удалось сохранить настройку.')).toBeVisible()
    expect(screen.getByRole('article', { name: 'Knight' })).toBeVisible()
  })

  it('supports V1 keyboard shortcuts without exposing generic IPC', async () => {
    render(<WidgetApp />)
    await screen.findByRole('article', { name: 'Knight' })

    fireEvent.keyDown(document, { key: 'p', ctrlKey: true })
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
        alwaysOnTop: false,
      }),
    )
    await screen.findByRole('button', { name: 'Закрепить поверх окон' })

    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
        locked: true,
      }),
    )
    await screen.findByRole('button', { name: 'Разблокировать позицию' })

    fireEvent.keyDown(document, { key: 'm', ctrlKey: true })
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
        displayMode: 'deck',
      }),
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(window.crToolsWidget.hide).toHaveBeenCalledOnce()
  })

  it('debounces Ctrl+wheel opacity and clamps it to the V2 safety range', async () => {
    render(<WidgetApp />)
    await screen.findByRole('article', { name: 'Knight' })

    fireEvent.wheel(document, { ctrlKey: false, deltaY: 100 })
    expect(window.crToolsWidget.updateSettings).not.toHaveBeenCalled()

    for (let index = 0; index < 20; index += 1) {
      fireEvent.wheel(document, { ctrlKey: true, deltaY: 100 })
    }

    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledOnce(),
    )
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledWith({ opacity: 0.55 })
  })

  it('serializes mode and wheel updates against the latest settings', async () => {
    let serverView: WidgetView = { ...widgetView }
    vi.mocked(window.crToolsWidget.getView).mockImplementation(() =>
      Promise.resolve(serverView),
    )
    vi.mocked(window.crToolsWidget.updateSettings).mockImplementation((patch) => {
      const settings = { ...serverView.settings, ...patch }
      serverView = { ...serverView, settings }
      return Promise.resolve(settings)
    })

    render(<WidgetApp />)
    await screen.findByRole('article', { name: 'Knight' })
    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид' }))
    fireEvent.wheel(document, { ctrlKey: true, deltaY: 100 })

    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(2),
    )
    expect(window.crToolsWidget.updateSettings).toHaveBeenNthCalledWith(1, {
      displayMode: 'deck',
    })
    expect(window.crToolsWidget.updateSettings).toHaveBeenNthCalledWith(2, {
      opacity: 0.91,
    })
    expect(await screen.findByText('Настройка сохранена')).toBeVisible()
  })

  it('auto-dismisses successful save feedback while retaining errors', async () => {
    vi.useFakeTimers()
    render(<WidgetApp />)
    await loadWidgetWithFakeTimers()
    expect(screen.getByRole('article', { name: 'Knight' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Настройка сохранена')).toBeVisible()

    await act(async () => vi.advanceTimersByTimeAsync(2_500))
    expect(screen.queryByText('Настройка сохранена')).not.toBeInTheDocument()

    vi.mocked(window.crToolsWidget.updateSettings).mockRejectedValueOnce(
      new Error('failed'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать позицию' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Не удалось сохранить настройку.')).toBeVisible()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(screen.getByText('Не удалось сохранить настройку.')).toBeVisible()
  })

  it('retries rejected and temporarily unavailable card assets with bounded backoff', async () => {
    vi.useFakeTimers()
    if (widgetView.result?.kind !== 'player_found') throw new Error('Fixture is invalid')
    vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
      ...widgetView,
      result: {
        ...widgetView.result,
        decks: [{ label: 'PoL', cards: [primaryCard] }],
      },
    })
    vi.mocked(window.crToolsWidget.getCardAsset)
      .mockRejectedValueOnce(new Error('not retained yet'))
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({
        kind: 'available',
        dataUrl: 'data:image/png;base64,AA==',
      })

    const { container } = render(<WidgetApp />)
    await loadWidgetWithFakeTimers()
    expect(screen.getByRole('article', { name: 'Knight' })).toBeVisible()
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(250))
    await act(async () => vi.advanceTimersByTimeAsync(750))
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(3)
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,AA==',
    )
  })

  it('stops retrying a persistently unavailable card after four attempts', async () => {
    vi.useFakeTimers()
    if (widgetView.result?.kind !== 'player_found') throw new Error('Fixture is invalid')
    vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
      ...widgetView,
      result: {
        ...widgetView.result,
        decks: [{ label: 'PoL', cards: [primaryCard] }],
      },
    })

    render(<WidgetApp />)
    await loadWidgetWithFakeTimers()
    await act(async () => vi.advanceTimersByTimeAsync(250))
    await act(async () => vi.advanceTimersByTimeAsync(750))
    await act(async () => vi.advanceTimersByTimeAsync(1_500))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))

    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(4)
  })

  it('backs off after image decode failure and cancels retries on deck change', async () => {
    vi.useFakeTimers()
    vi.mocked(window.crToolsWidget.getCardAsset).mockResolvedValue({
      kind: 'available',
      dataUrl: 'data:image/png;base64,AA==',
    })
    const { container, unmount } = render(<WidgetApp />)
    await loadWidgetWithFakeTimers()
    const image = container.querySelector('img')
    if (image === null) throw new Error('Card image was not rendered')
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(8)

    fireEvent.error(image)
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(8)
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(9)

    const retriedImage = container.querySelector('img')
    if (retriedImage === null) throw new Error('Retried card image was not rendered')
    fireEvent.error(retriedImage)
    fireEvent.click(screen.getByRole('tab', { name: 'Колода 2: Турнир' }))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(9)

    vi.mocked(window.crToolsWidget.getCardAsset).mockResolvedValueOnce({
      kind: 'unavailable',
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Колода 1: PoL' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(17)
    unmount()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(17)
  })
})
