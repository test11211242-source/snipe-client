// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_WIDGET_SETTINGS } from '../../../electron/main/infrastructure/widget-settings-repository'
import { WidgetSettingsSchema, type WidgetView } from '../../../shared/models/widget'
import { WidgetApp } from './WidgetApp'

const card = (name: string, hasImage = true) => ({
  name,
  level: 14,
  evolutionLevel: null,
  hasImage,
})

const primaryCards = [
  'Knight',
  ...Array.from({ length: 7 }, (_, i) => `Card ${i + 2}`),
].map((name) => card(name))

const resultId = '29d970c1-fc4f-4bea-a767-8f108d3b8739'

const widgetView: WidgetView = {
  settings: DEFAULT_WIDGET_SETTINGS,
  visible: true,
  monitorState: 'READY',
  monitorError: null,
  runIntent: true,
  search: null,
  sourceMinimized: false,
  scale: 1,
  result: {
    id: resultId,
    kind: 'player_found',
    timestamp: '2026-07-12T12:00:00.000Z',
    searchedNickname: 'Opponent',
    reprocessed: false,
    player: { name: 'Opponent', tag: '#TAG', rating: 2000, clan: 'Clan' },
    decks: [
      { label: 'PoL', cards: primaryCards },
      { label: 'Турнир', cards: [card('Archer', false)] },
    ],
  },
}

const search = (phase: 'capturing' | 'requesting', nickname: string | null) => ({
  triggerId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  profileId: '33333333-3333-4333-8333-333333333333',
  calibrationRevision: 1,
  phase,
  startedAt: '2026-07-12T12:00:00.000Z',
  searchedNickname: nickname,
  retryExpiresAt: null,
})

let pushedView: ((view: WidgetView) => void) | null = null
let resizeCallback: (() => void) | null = null
let contentHeight = 240

class FakeResizeObserver {
  constructor(callback: () => void) {
    resizeCallback = callback
  }
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

function push(view: WidgetView): void {
  act(() => pushedView?.(view))
}

describe('WidgetApp', () => {
  it.each([
    { alwaysOnTop: true, locked: false, compactMode: false },
    { alwaysOnTop: true, locked: true, compactMode: false },
    { alwaysOnTop: true, locked: true, compactMode: true },
  ])('close dispatches hide for pinned/locked/compact: %j', async (settings) => {
    vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
      ...widgetView,
      settings: { ...widgetView.settings, ...settings },
    })
    render(<WidgetApp />)
    const close = await screen.findByRole('button', { name: 'Скрыть оверлей' })
    fireEvent.click(close)
    expect(window.crToolsWidget.hide).toHaveBeenCalledOnce()
  })
  it('#15 retries a failed height report without another resize', async () => {
    vi.useFakeTimers()
    vi.mocked(window.crToolsWidget.updateSettings).mockRejectedValueOnce(new Error('IPC'))
    render(<WidgetApp />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(2)
    expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
      contentHeight: 240,
    })
  })

  it('dedupes unchanged height across mode and scale updates', async () => {
    vi.useFakeTimers()
    render(<WidgetApp />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(1)
    push({ ...widgetView, settings: { ...widgetView.settings, compactMode: true } })
    await act(async () => vi.advanceTimersByTimeAsync(200))
    act(() => resizeCallback?.())
    push({ ...widgetView, scale: 1.2 })
    act(() => resizeCallback?.())
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('#16 accepts changed result content even when id and reprocessed are unchanged', async () => {
    vi.useFakeTimers()
    render(<WidgetApp />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    if (widgetView.result?.kind !== 'player_found') throw new Error('missing fixture')
    vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
      ...widgetView,
      result: {
        ...widgetView.result,
        player: { ...widgetView.result.player, name: 'Изменённый соперник' },
      },
    })
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(screen.getByRole('heading', { name: 'Изменённый соперник' })).toBeVisible()
  })
  beforeEach(() => {
    pushedView = null
    resizeCallback = null
    contentHeight = 240
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ height: contentHeight, width: 360 }) as DOMRect,
    )
    Object.defineProperty(window, 'crToolsWidget', {
      configurable: true,
      value: Object.freeze({
        rendererReady: vi.fn().mockResolvedValue(undefined),
        getView: vi.fn().mockResolvedValue(widgetView),
        onViewChanged: vi.fn((listener: (view: WidgetView) => void) => {
          pushedView = listener
          return () => {
            pushedView = null
          }
        }),
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

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders a pushed opponent immediately without waiting for polling', async () => {
    render(<WidgetApp />)
    expect(await screen.findByRole('heading', { name: 'Opponent' })).toBeVisible()
    expect(screen.getByLabelText('Рейтинг 2000')).toBeVisible()
    expect(screen.getByText('Clan')).toBeVisible()

    if (widgetView.result?.kind !== 'player_found') throw new Error('Fixture is invalid')
    push({
      ...widgetView,
      result: {
        ...widgetView.result,
        id: '49d970c1-fc4f-4bea-a767-8f108d3b8739',
        player: { ...widgetView.result.player, name: 'Instant Opponent' },
      },
    })

    expect(screen.getByRole('heading', { name: 'Instant Opponent' })).toBeVisible()
    expect(window.crToolsWidget.getView).toHaveBeenCalledOnce()
  })

  it('marks a reprocessed entry while keeping its opponent visible', async () => {
    render(<WidgetApp />)
    expect(await screen.findByRole('heading', { name: 'Opponent' })).toBeVisible()
    if (widgetView.result === null) throw new Error('Missing result fixture')
    push({ ...widgetView, result: { ...widgetView.result, reprocessed: true } })
    expect(screen.getByText('Переобработано · вне статистики сессии')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Opponent' })).toBeVisible()
  })

  it('does not lose a pushed opponent while a setting is being saved', async () => {
    const saving = deferred<WidgetView['settings']>()
    vi.mocked(window.crToolsWidget.updateSettings).mockReturnValueOnce(saving.promise)
    render(<WidgetApp />)
    expect(await screen.findByRole('heading', { name: 'Opponent' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Открепить от переднего плана' }))
    if (widgetView.result?.kind !== 'player_found') throw new Error('Fixture is invalid')
    push({
      ...widgetView,
      result: {
        ...widgetView.result,
        id: '69d970c1-fc4f-4bea-a767-8f108d3b8739',
        player: { ...widgetView.result.player, name: 'Opponent During Save' },
      },
    })
    expect(screen.getByRole('heading', { name: 'Opponent During Save' })).toBeVisible()

    await act(async () => {
      saving.resolve({ ...widgetView.settings, alwaysOnTop: false })
      await saving.promise
    })
    expect(screen.getByRole('heading', { name: 'Opponent During Save' })).toBeVisible()
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
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledWith({
        alwaysOnTop: false,
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Закрепить поверх окон' }),
      ).not.toBeDisabled(),
    )
  })

  it('renders compact as 2x4 with only nickname, medals and inline deck numbers', async () => {
    const { container } = render(<WidgetApp />)
    const normal = await screen.findByRole('list', { name: 'Карты колоды 1' })
    expect(normal.style.getPropertyValue('--cols')).toBe('4')
    expect(normal.querySelectorAll('li')).toHaveLength(8)

    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид' }))
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
        compactMode: true,
      }),
    )
    await waitFor(() =>
      expect(container.querySelector('main')).toHaveAttribute('data-compact', 'true'),
    )
    const compact = screen.getByRole('list', { name: 'Карты колоды 1' })
    expect(compact.style.getPropertyValue('--cols')).toBe('4')
    expect(compact.querySelectorAll('li')).toHaveLength(8)
    expect(screen.queryByText('Clan')).not.toBeInTheDocument()
    expect(screen.queryByText('#TAG')).not.toBeInTheDocument()
    expect(screen.queryByText('Соперник найден')).not.toBeInTheDocument()
    const rating = screen.getByLabelText('Рейтинг 2000')
    expect(rating.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('rating.png'),
    )
    const switcher = screen.getByRole('tablist', { name: 'Колоды' })
    expect(switcher.parentElement).toBe(
      screen.getByRole('heading', { name: 'Opponent' }).parentElement,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Колода 2' }))
    expect(screen.getByRole('list', { name: 'Карты колоды 2' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Полный вид' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('heading', { name: 'Opponent' })).toBeVisible()
  })

  it('scales everything with the width-derived scale from the widget view', async () => {
    const { container } = render(<WidgetApp />)
    await screen.findByRole('heading', { name: 'Opponent' })
    const shell = container.querySelector('main')
    expect(shell?.style.getPropertyValue('--ow-k')).toBe('1')
    push({ ...widgetView, scale: 1.4 })
    expect(shell?.style.getPropertyValue('--ow-k')).toBe('1.4')
  })

  it('reports once per height change', async () => {
    vi.useFakeTimers()
    render(<WidgetApp />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByRole('heading', { name: 'Opponent' })).toBeVisible()

    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(1)
    expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
      contentHeight: 240,
    })

    // The main process echoes new settings and the observer fires again: same height.
    act(() => resizeCallback?.())
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(1)

    contentHeight = 301.2
    act(() => resizeCallback?.())
    act(() => resizeCallback?.())
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(2)
    expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
      contentHeight: 302,
    })

    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(window.crToolsWidget.updateSettings).toHaveBeenCalledTimes(2)
  })

  it('keeps the height clamped to the native 80–720 range', async () => {
    vi.useFakeTimers()
    contentHeight = 4_000
    render(<WidgetApp />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
      contentHeight: 720,
    })
  })

  it('switches decks with the tabs and labels them «Колода N из M»', async () => {
    render(<WidgetApp />)
    await screen.findByRole('list', { name: 'Карты колоды 1' })
    expect(screen.getByText('из 2', { exact: false })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Колода 2' }))
    expect(await screen.findByRole('list', { name: 'Карты колоды 2' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Archer' })).toBeVisible()
  })

  it('adds no deck navigation when only one deck is available', async () => {
    if (widgetView.result?.kind !== 'player_found') throw new Error('Fixture is invalid')
    vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
      ...widgetView,
      result: { ...widgetView.result, decks: widgetView.result.decks.slice(0, 1) },
    })
    render(<WidgetApp />)
    expect(await screen.findByRole('list', { name: 'Карты колоды 1' })).toBeVisible()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('shows mutation errors without hiding the current deck', async () => {
    vi.mocked(window.crToolsWidget.updateSettings).mockRejectedValueOnce(
      new Error('failed'),
    )
    render(<WidgetApp />)
    await screen.findByRole('list', { name: 'Карты колоды 1' })
    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид' }))
    expect(await screen.findByText('Не удалось сохранить настройку.')).toBeVisible()
    expect(screen.getByRole('list', { name: 'Карты колоды 1' })).toBeVisible()
  })

  it('pins and locks through visible controls, ignores removed shortcuts, and hides on Escape', async () => {
    render(<WidgetApp />)
    await screen.findByRole('list', { name: 'Карты колоды 1' })

    fireEvent.keyDown(document, { key: 'p', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'l', ctrlKey: true })
    fireEvent.keyDown(document, { key: 'm', ctrlKey: true })
    expect(window.crToolsWidget.updateSettings).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Открепить от переднего плана' }))
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
        alwaysOnTop: false,
      }),
    )
    await screen.findByRole('button', { name: 'Закрепить поверх окон' })

    fireEvent.click(screen.getByRole('button', { name: 'Заблокировать позицию' }))
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
        locked: true,
      }),
    )
    await screen.findByRole('button', { name: 'Разблокировать позицию' })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(window.crToolsWidget.hide).toHaveBeenCalledOnce()
  })

  it('hides through the close button and keeps unlock reachable while locked', async () => {
    vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
      ...widgetView,
      settings: { ...widgetView.settings, locked: true },
    })
    const { container } = render(<WidgetApp />)
    const unlock = await screen.findByRole('button', { name: 'Разблокировать позицию' })
    expect(container.querySelector('main')).toHaveAttribute('data-locked', 'true')
    fireEvent.click(unlock)
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenLastCalledWith({
        locked: false,
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть оверлей' }))
    expect(window.crToolsWidget.hide).toHaveBeenCalledOnce()
  })

  it('debounces Ctrl+wheel opacity and clamps it to the safety range', async () => {
    render(<WidgetApp />)
    await screen.findByRole('list', { name: 'Карты колоды 1' })
    fireEvent.wheel(document, { ctrlKey: false, deltaY: 100 })
    for (let index = 0; index < 20; index += 1) {
      fireEvent.wheel(document, { ctrlKey: true, deltaY: 100 })
    }
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledWith({ opacity: 0.55 }),
    )
  })

  it('serializes mode and wheel updates against the latest settings', async () => {
    let serverView: WidgetView = { ...widgetView }
    vi.mocked(window.crToolsWidget.getView).mockImplementation(() =>
      Promise.resolve(serverView),
    )
    vi.mocked(window.crToolsWidget.updateSettings).mockImplementation((patch) => {
      const settings = WidgetSettingsSchema.parse({
        ...serverView.settings,
        ...(patch as object),
      })
      serverView = { ...serverView, settings }
      return Promise.resolve(settings)
    })
    render(<WidgetApp />)
    await screen.findByRole('list', { name: 'Карты колоды 1' })
    fireEvent.click(screen.getByRole('button', { name: 'Компактный вид' }))
    fireEvent.wheel(document, { ctrlKey: true, deltaY: 100 })
    await waitFor(() =>
      expect(window.crToolsWidget.updateSettings).toHaveBeenCalledWith({ opacity: 0.91 }),
    )
    const calls = vi.mocked(window.crToolsWidget.updateSettings).mock.calls
    const compactIndex = calls.findIndex(([patch]) => 'compactMode' in patch)
    const opacityIndex = calls.findIndex(([patch]) => 'opacity' in patch)
    expect(compactIndex).toBeGreaterThanOrEqual(0)
    expect(compactIndex).toBeLessThan(opacityIndex)
  })

  describe('states with real data', () => {
    it('searching shows only a really read nickname and skeleton cards otherwise', async () => {
      vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
        ...widgetView,
        search: search('capturing', null),
      })
      render(<WidgetApp />)
      expect(await screen.findByText('Ищем соперника')).toBeVisible()
      expect(screen.getByText('Читаем ник…')).toBeVisible()
      // The previous opponent is never shown while a new search runs.
      expect(screen.queryByRole('heading', { name: 'Opponent' })).not.toBeInTheDocument()

      push({ ...widgetView, search: search('requesting', 'Voron_17') })
      expect(screen.getByRole('heading', { name: 'Voron_17' })).toBeVisible()
      expect(screen.getByText('Ищем игрока в базе…')).toBeVisible()
    })

    it.each([
      [
        'player_not_found',
        'Нет в базе',
        { kind: 'player_not_found' as const, message: 'Игрок не найден' },
      ],
      [
        'recognition_failed',
        'Ник не прочитан',
        { kind: 'recognition_failed' as const, message: 'Не прочитан' },
      ],
      [
        'service_error',
        'Сбой сервиса',
        { kind: 'service_error' as const, message: 'Сервис недоступен' },
      ],
    ])('shows %s calmly', async (_kind, status, patch) => {
      vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
        ...widgetView,
        result: {
          id: resultId,
          timestamp: '2026-07-12T12:00:00.000Z',
          searchedNickname: 'Voron_17',
          reprocessed: false,
          ...patch,
        },
      })
      render(<WidgetApp />)
      expect(await screen.findByText(status)).toBeVisible()
    })

    it('waits for the game window and explains a required rebind', async () => {
      vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
        ...widgetView,
        result: null,
        monitorState: 'WAITING_SOURCE',
      })
      render(<WidgetApp />)
      expect(await screen.findByText('Ждём окно игры…')).toBeVisible()

      push({
        ...widgetView,
        result: null,
        monitorState: 'FAILED',
        runIntent: false,
        monitorError: {
          code: 'SOURCE_REBIND_REQUIRED',
          message: 'Выберите окно игры заново в профиле',
        },
      })
      expect(screen.getByText('Нужна перенастройка')).toBeVisible()
      expect(screen.getByText('Выберите окно игры заново в профиле')).toBeVisible()
    })

    it('waits for a battle and shows a stopped monitor', async () => {
      vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
        ...widgetView,
        result: null,
      })
      render(<WidgetApp />)
      expect(await screen.findByText('Ждём бой')).toBeVisible()
      push({ ...widgetView, result: null, monitorState: 'STOPPED', runIntent: false })
      expect(
        screen.getByText('Мониторинг остановлен', { selector: 'span' }),
      ).toBeVisible()
    })

    it('says the game window is minimised, keeping a found deck', async () => {
      vi.mocked(window.crToolsWidget.getView).mockResolvedValue({
        ...widgetView,
        sourceMinimized: true,
      })
      render(<WidgetApp />)
      expect(await screen.findByText('Окно игры свёрнуто')).toBeVisible()
      expect(screen.getByRole('heading', { name: 'Opponent' })).toBeVisible()

      push({ ...widgetView, result: null, sourceMinimized: true })
      expect(screen.getByRole('heading', { name: 'Окно игры свёрнуто' })).toBeVisible()
      push({ ...widgetView, result: null })
      expect(screen.getByText('Ждём бой')).toBeVisible()
    })
  })

  describe('native drag', () => {
    // Compact collapses the header strip to zero height, so there it is no handle.
    const sizedHandles = (): Element[] => {
      const shell = screen.getByRole('main')
      const compact = shell.getAttribute('data-compact') === 'true'
      return [...shell.querySelectorAll('[data-drag-handle]')].filter(
        (handle) => !(compact && handle.tagName === 'HEADER'),
      )
    }

    it.each<[string, WidgetView]>([
      ['found', widgetView],
      ['waiting for the game window', { ...widgetView, monitorState: 'WAITING_SOURCE' }],
      ['reading a nickname', { ...widgetView, search: search('capturing', null) }],
      [
        'searching a nickname',
        { ...widgetView, search: search('requesting', 'Voron_17') },
      ],
      [
        'stopped',
        { ...widgetView, result: null, monitorState: 'STOPPED', runIntent: false },
      ],
    ])('%s stays draggable across every mode switch', async (_state, view) => {
      vi.mocked(window.crToolsWidget.getView).mockResolvedValue(view)
      render(<WidgetApp />)
      await screen.findByRole('button', { name: 'Компактный вид' })
      expect(sizedHandles()).not.toHaveLength(0)
      for (const compact of [true, false, true]) {
        fireEvent.click(
          screen.getByRole('button', { name: compact ? 'Компактный вид' : 'Полный вид' }),
        )
        await waitFor(() =>
          expect(screen.getByRole('main')).toHaveAttribute(
            'data-compact',
            String(compact),
          ),
        )
        expect(sizedHandles()).not.toHaveLength(0)
      }
    })

    it('declares native drag once, on the handles, and never for a locked overlay', () => {
      const overlayCss = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'Overlay.module.css'),
        'utf8',
      )
      const dragSelectors = [
        ...overlayCss.matchAll(/([^{}]+)\{[^}]*-webkit-app-region:\s*drag;/g),
      ].map((match) => (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
      expect(dragSelectors).toEqual(['.shell [data-drag-handle]'])
      expect(overlayCss).toMatch(
        /\.shell\[data-locked='true'\] \[data-drag-handle\] \{[^}]*-webkit-app-region: no-drag;/,
      )
      // The premise of `sizedHandles`: compact hides the header strip.
      expect(overlayCss).toMatch(
        /\.shell\[data-compact='true'\] \.top \{[^}]*\bheight: 0;/,
      )
    })
  })

  describe('card art', () => {
    it('retries unavailable assets with bounded backoff, then paints the image', async () => {
      vi.useFakeTimers()
      let knightCalls = 0
      vi.mocked(window.crToolsWidget.getCardAsset).mockImplementation((request) => {
        if (request.cardIndex !== 0) return Promise.resolve({ kind: 'unavailable' })
        knightCalls += 1
        if (knightCalls === 1) return Promise.reject(new Error('not retained yet'))
        if (knightCalls === 2) return Promise.resolve({ kind: 'unavailable' })
        return Promise.resolve({
          kind: 'available',
          dataUrl: 'data:image/png;base64,AA==',
        })
      })
      render(<WidgetApp />)
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(8)
      await act(async () => vi.advanceTimersByTimeAsync(250))
      await act(async () => vi.advanceTimersByTimeAsync(750))
      await act(async () => vi.advanceTimersByTimeAsync(1_500))
      expect(screen.getByRole('img', { name: 'Knight' })).toHaveAttribute(
        'src',
        'data:image/png;base64,AA==',
      )
    })

    it('stops retrying a persistently unavailable card after four attempts', async () => {
      vi.useFakeTimers()
      render(<WidgetApp />)
      await act(async () => vi.advanceTimersByTimeAsync(0))
      await act(async () => vi.advanceTimersByTimeAsync(5_000))
      expect(window.crToolsWidget.getCardAsset).toHaveBeenCalledTimes(8 * 4)
      expect(screen.getAllByRole('img', { name: /Card|Knight/ })).toHaveLength(8)
    })

    it('shows the placeholder for a card without art and requests nothing for it', async () => {
      render(<WidgetApp />)
      await screen.findByRole('list', { name: 'Карты колоды 1' })
      fireEvent.click(screen.getByRole('tab', { name: 'Колода 2' }))
      const archer = await screen.findByRole('img', { name: 'Archer' })
      expect(archer.tagName).toBe('SPAN')
      expect(window.crToolsWidget.getCardAsset).not.toHaveBeenCalledWith(
        expect.objectContaining({ deckIndex: 1 }),
      )
    })
  })
})
