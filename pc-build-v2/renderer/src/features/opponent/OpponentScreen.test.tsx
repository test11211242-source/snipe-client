// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MonitorResult, MonitorView } from '../../../../shared/models/monitor'
import { monitorViewFixture } from '../../../../tests/monitor-fixtures'
import { AppRoot } from '../../app/AppRoot'
import { installBridge, profilesFixture, type Bridge } from '../../test/bridge'
import { clockTime } from '../h2h/format'

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOW = Date.now()
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

function cards(count = 8, withArt = true) {
  return Array.from({ length: count }, (_, index) => ({
    name: `Карта ${index + 1}`,
    level: 14,
    evolutionLevel: index === 0 ? 1 : null,
    iconUrl: withArt ? `https://api-assets.clashroyale.com/cards/${index}.png` : null,
  }))
}

type Found = Extract<MonitorResult, { kind: 'player_found' }>

function found(n: number, patch: Partial<Found> = {}): MonitorResult {
  return {
    id: uuid(n),
    kind: 'player_found',
    timestamp: iso(-n * 60_000),
    searchMode: 'fast',
    deckMode: 'pol',
    searchedNickname: `Искали${n}`,
    reprocessed: false,
    capturePolicy: 'immediate_nickname',
    sessionId: null,
    triggerId: uuid(100 + n),
    attemptId: uuid(200 + n),
    profileId: uuid(1),
    calibrationRevision: 1,
    repeat: null,
    player: {
      name: `Игрок${n}`,
      tag: '#2Q8YLP0',
      rating: 2487,
      clan: 'Северный ветер',
    },
    decks: [
      { label: 'PoL', cards: cards() },
      { label: 'Турнир', cards: cards() },
      { label: null, cards: cards() },
    ],
    ...patch,
  }
}

function failure(
  n: number,
  kind: 'player_not_found' | 'recognition_failed' | 'service_error',
  patch: Record<string, unknown> = {},
): MonitorResult {
  const base = {
    id: uuid(n),
    timestamp: iso(-n * 60_000),
    searchMode: 'fast' as const,
    deckMode: 'pol' as const,
    searchedNickname: `Ник${n}`,
    reprocessed: false,
    capturePolicy: 'immediate_nickname' as const,
    sessionId: null,
    triggerId: uuid(100 + n),
    attemptId: uuid(200 + n),
    profileId: uuid(1),
    calibrationRevision: 1,
    repeat: null,
    message: 'Сообщение сервиса',
  }
  if (kind === 'service_error')
    return { ...base, kind, retryable: true, authBlocked: false, ...patch }
  return { ...base, kind, ...patch }
}

const search = (n: number, patch: Record<string, unknown> = {}) => ({
  triggerId: uuid(100 + n),
  attemptId: uuid(200 + n),
  profileId: uuid(1),
  calibrationRevision: 1,
  phase: 'requesting' as const,
  startedAt: iso(-5_000),
  searchedNickname: null,
  retryExpiresAt: null,
  ...patch,
})

const running = (patch: Partial<MonitorView> = {}): MonitorView =>
  monitorViewFixture({ state: 'READY', runIntent: true, ...patch })

const h2hData = (patch: Record<string, unknown> = {}) => ({
  status: 'ok',
  opponent: { tag: '#2Q8YLP0', name: null },
  scope: 'recorded_path_of_legends',
  coverage: { source: 'cr_stats_current_and_archives', complete: true },
  updatedAt: iso(0),
  stale: false,
  totals: { meetings: 4, wins: 3, losses: 1, draws: 0, decisiveMeetings: 4, winRate: 75 },
  last: { at: iso(-86_400_000), result: 'win', accountTag: '#88299RC9Y' },
  recent: [
    { at: iso(-86_400_000), result: 'win', accountTag: '#88299RC9Y' },
    { at: iso(-5 * 86_400_000), result: 'loss', accountTag: '#22LUPYCYC' },
  ],
  perAccount: [
    {
      accountTag: '#88299RC9Y',
      alias: 'Основной',
      meetings: 3,
      wins: 3,
      losses: 0,
      draws: 0,
      decisiveMeetings: 3,
      winRate: 100,
      lastAt: iso(-86_400_000),
      lastResult: 'win',
    },
  ],
  ...patch,
})

let bridge: Bridge

async function renderMain(options: Parameters<typeof installBridge>[0] = {}) {
  bridge = installBridge({
    profiles: profilesFixture(),
    monitor: running(),
    ...options,
  })
  bridge.crTools.h2h.lookup.mockImplementation(({ requestId }: { requestId: string }) =>
    Promise.resolve({ capability: 'supported', requestId, data: h2hData() }),
  )
  render(<AppRoot />)
  await screen.findByRole('navigation', { name: 'Главная панель' })
}

function pushView(view: MonitorView): void {
  act(() => bridge.push(view))
}

beforeEach(() => {
  window.innerWidth = 1100
})
afterEach(() => vi.useRealTimers())

describe('opponent card: found', () => {
  it('shows name, labelled tag with copy, clan, rating with medal and eight image slots', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    expect(await screen.findByRole('heading', { name: 'Игрок1' })).toBeVisible()
    expect(screen.getByText('Тег игрока')).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: 'Соперник' })).getByText(
        'Северный ветер',
      ),
    ).toBeVisible()
    expect(screen.getByText('Рейтинг')).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: 'Соперник' })).getByText('2 487'),
    ).toBeVisible()
    expect(screen.getByText(/Колода/, { selector: 'span' })).toHaveTextContent(
      'Колода 1 из 3',
    )

    const deck = screen.getByRole('list', { name: 'Карты колоды 1' })
    expect(within(deck).getAllByRole('listitem')).toHaveLength(8)
    // Art only: no level or evolution badges anywhere in the deck.
    expect(deck).not.toHaveTextContent(/14|эво/i)

    fireEvent.click(screen.getByRole('button', { name: 'Скопировать тег #2Q8YLP0' }))
    await waitFor(() =>
      expect(bridge.crTools.copyPlayerTag).toHaveBeenCalledWith('#2Q8YLP0'),
    )
    expect(await screen.findByText('Тег скопирован')).toBeVisible()
  })

  it('fetches card art by result reference and keeps a placeholder for missing art', async () => {
    bridge = installBridge({ monitor: running({ results: [found(1)] }) })
    bridge.crTools.getCardAsset.mockImplementation(
      ({ cardIndex }: { cardIndex: number }) =>
        Promise.resolve(
          cardIndex === 0
            ? { kind: 'available', dataUrl: 'data:image/png;base64,AA==' }
            : { kind: 'unavailable' },
        ),
    )
    render(<AppRoot />)
    const art = await screen.findByRole('img', { name: 'Карта 1' })
    expect(art).toHaveAttribute('src', 'data:image/png;base64,AA==')
    expect(bridge.crTools.getCardAsset).toHaveBeenCalledWith({
      resultId: uuid(1),
      deckIndex: 0,
      cardIndex: 0,
    })
    // No remote URL ever reaches an <img> of the main window.
    expect(document.querySelectorAll('img[src^="https:"]')).toHaveLength(0)
  })

  it('renders the placeholder for iconUrl: null and still shows eight slots', async () => {
    const result = found(1, { decks: [{ label: null, cards: cards(5, false) }] })
    await renderMain({ monitor: running({ results: [result] }) })
    const deck = await screen.findByRole('list', { name: 'Карты колоды 1' })
    expect(within(deck).getAllByRole('listitem')).toHaveLength(8)
    expect(within(deck).getAllByRole('img', { name: /Карта/ })).toHaveLength(5)
    expect(bridge.crTools.getCardAsset).not.toHaveBeenCalled()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('labels decks «Колода N» and switches between them', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    await screen.findByRole('heading', { name: 'Игрок1' })
    fireEvent.click(screen.getByRole('tab', { name: 'Колода 3' }))
    expect(screen.getByRole('list', { name: 'Карты колоды 3' })).toBeVisible()
    expect(screen.getByText(/Колода/, { selector: 'span' })).toHaveTextContent(
      'Колода 3 из 3',
    )
  })

  it('shows «уже встречались сегодня» only from the structured repeat field', async () => {
    const previousAt = iso(-3 * 3_600_000)
    const repeat = { previousAt, previousResultId: uuid(9), localDay: '2026-10-10' }
    await renderMain({
      monitor: running({
        results: [
          found(1, { repeat }),
          // Same nickname, no repeat field: never guessed.
          found(2, {
            player: { name: 'Игрок1', tag: '#2Q8YLP0', rating: 1, clan: null },
          }),
        ],
      }),
    })
    expect(
      await screen.findByText(`Уже встречались сегодня, в ${clockTime(previousAt)}`, {
        exact: false,
      }),
    ).toBeVisible()
    expect(screen.getAllByText('уже играли')).toHaveLength(1)

    pushView(
      running({
        results: [
          found(3, {
            player: { name: 'Игрок1', tag: '#2Q8YLP0', rating: 1, clan: null },
          }),
        ],
      }),
    )
    await waitFor(() =>
      expect(screen.queryByText(/Уже встречались сегодня/)).not.toBeInTheDocument(),
    )
    expect(screen.queryByText('уже играли')).not.toBeInTheDocument()
  })

  it('applies a deck-mode change to the next search and keeps the shown result mode', async () => {
    await renderMain({
      monitor: running({ results: [found(1, { deckMode: 'pol' })] }),
    })
    await screen.findByRole('heading', { name: 'Игрок1' })
    fireEvent.click(screen.getByRole('button', { name: 'Турнир' }))
    await waitFor(() =>
      expect(bridge.crTools.updateMonitorPreferences).toHaveBeenCalledWith({
        deckMode: 'gt',
      }),
    )
    pushView(
      running({
        preferences: { deckMode: 'gt' },
        results: [found(1, { deckMode: 'pol' })],
      }),
    )
    expect(await screen.findByText('Колоды: Путь легенд')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Игрок1' })).toBeVisible()
  })

  it('opens the overlay from the card', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Оверлей' }))
    expect(bridge.crTools.showWidget).toHaveBeenCalledOnce()
  })
})

describe('opponent card: states', () => {
  it('guides the first run to profile creation', async () => {
    await renderMain({ profiles: profilesFixture([]), monitor: monitorViewFixture() })
    expect(await screen.findByText('Давайте настроим CR Tools')).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: 'Соперник' })).getByRole('button', {
        name: /Создать профиль/,
      }),
    ).toBeVisible()
  })

  it('shows the real startup checks while starting', async () => {
    await renderMain({
      monitor: monitorViewFixture({
        state: 'STARTING',
        runIntent: true,
        readiness: {
          authenticated: true,
          captureConfigured: true,
          sourceAvailable: null,
        },
      }),
    })
    expect(
      await screen.findByText('Запускаем мониторинг…', { selector: 'h2' }),
    ).toBeVisible()
    const steps = screen.getByRole('list', { name: 'Проверки запуска' })
    expect(within(steps).getByText('Вход в аккаунт')).toBeVisible()
    expect(within(steps).getByText('Окно игры найдено')).toBeVisible()
  })

  it('waits for a battle', async () => {
    await renderMain()
    expect(await screen.findByText('Ждём бой', { selector: 'h2' })).toBeVisible()
  })

  it('searching shows skeletons and no nickname before it is read', async () => {
    await renderMain({
      monitor: running({
        results: [found(1)],
        search: search(2, { phase: 'capturing' }),
      }),
    })
    expect(await screen.findByText('Читаем ник…')).toBeVisible()
    // The previous opponent is not presented as the current one.
    expect(screen.queryByRole('heading', { name: 'Игрок1' })).not.toBeInTheDocument()
    pushView(
      running({
        results: [found(1)],
        search: search(2, { phase: 'requesting', searchedNickname: 'Voron_17' }),
      }),
    )
    expect(await screen.findByRole('heading', { name: 'Voron_17' })).toBeVisible()
    expect(screen.getByText('Ищем игрока в базе…')).toBeVisible()
  })

  it('explains «нет в базе» and «ник не прочитан» without red alarms', async () => {
    await renderMain({ monitor: running({ results: [failure(1, 'player_not_found')] }) })
    expect(await screen.findByText('Игрока нет в базе')).toBeVisible()
    expect(screen.getByText('Прочитано: «Ник1»')).toBeVisible()

    pushView(running({ results: [failure(2, 'recognition_failed')] }))
    expect(await screen.findByText('Не удалось прочитать ник')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Перенастроить профиль' }))
    expect(await screen.findByRole('dialog', { name: 'Профили' })).toBeVisible()
  })

  it('offers a retry for a service error only while the attempt is valid', async () => {
    const error = failure(1, 'service_error')
    await renderMain({
      monitor: running({
        results: [error],
        search: search(1, { phase: 'failed', retryExpiresAt: iso(60_000) }),
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить поиск' }))
    await waitFor(() =>
      expect(bridge.crTools.retryMonitorSearch).toHaveBeenCalledWith({
        attemptId: uuid(201),
      }),
    )

    // A different attempt, an expired deadline or a missing deadline: no retry.
    pushView(
      running({
        results: [error],
        search: search(7, { phase: 'failed', retryExpiresAt: iso(60_000) }),
      }),
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Повторить поиск' }),
      ).not.toBeInTheDocument(),
    )
    pushView(
      running({
        results: [error],
        search: search(1, { phase: 'failed', retryExpiresAt: iso(-1_000) }),
      }),
    )
    expect(
      screen.queryByRole('button', { name: 'Повторить поиск' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Сервис поиска временно недоступен')).toBeVisible()
  })

  it('removes the retry button when the retry window closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const error = failure(1, 'service_error')
    bridge = installBridge({
      monitor: running({
        results: [error],
        search: search(1, {
          phase: 'failed',
          retryExpiresAt: new Date(Date.now() + 5_000).toISOString(),
        }),
      }),
    })
    render(<AppRoot />)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByRole('button', { name: 'Повторить поиск' })).toBeVisible()
    await act(async () => vi.advanceTimersByTimeAsync(5_200))
    expect(
      screen.queryByRole('button', { name: 'Повторить поиск' }),
    ).not.toBeInTheDocument()
  })

  it('asks to sign in again when the service blocked the account', async () => {
    await renderMain({
      monitor: running({ results: [failure(1, 'service_error', { authBlocked: true })] }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Войти заново' }))
    await waitFor(() => expect(bridge.crTools.logout).toHaveBeenCalledOnce())
  })

  it('waits calmly for the game window with Stop and no retry', async () => {
    await renderMain({
      monitor: monitorViewFixture({ state: 'WAITING_SOURCE', runIntent: true }),
    })
    expect(await screen.findByText('Ждём окно игры…', { selector: 'h2' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Повторить/ })).not.toBeInTheDocument()
    const stops = screen.getAllByRole('button', { name: 'Остановить' })
    fireEvent.click(stops[stops.length - 1] ?? stops[0] ?? document.body)
    await waitFor(() => expect(bridge.crTools.stopMonitor).toHaveBeenCalled())
  })

  it('sends SOURCE_REBIND_REQUIRED to the profiles panel', async () => {
    await renderMain({
      monitor: monitorViewFixture({
        state: 'FAILED',
        runIntent: false,
        error: {
          code: 'SOURCE_REBIND_REQUIRED',
          message: 'Выберите окно игры заново в профиле',
        },
      }),
    })
    expect(await screen.findByText('Выберите окно игры заново в профиле')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть профили' }))
    expect(await screen.findByRole('dialog', { name: 'Профили' })).toBeVisible()
  })

  it('shows a failed start with its code and the retry action', async () => {
    await renderMain({
      monitor: monitorViewFixture({
        state: 'FAILED',
        runIntent: false,
        error: { code: 'CAPTURE_FAILED', message: 'Не удалось получить кадр' },
      }),
    })
    expect(
      await screen.findByText('Не удалось запустить', { selector: 'h2' }),
    ).toBeVisible()
    expect(screen.getByText('CAPTURE_FAILED')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить запуск' }))
    await waitFor(() => expect(bridge.crTools.startMonitor).toHaveBeenCalled())
  })

  it('keeps the last result visible and announces reconnection when offline', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    expect(await screen.findByRole('heading', { name: 'Игрок1' })).toBeVisible()
    bridge.crTools.getRealtimeStatus.mockResolvedValue({
      state: 'BACKOFF',
      desiredConnected: true,
      reconnectAttempt: 3,
      unknownEventCount: 0,
    })
    expect(await screen.findByText(/попытка 3/, {}, { timeout: 7_000 })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Игрок1' })).toBeVisible()
  }, 10_000)
})

describe('session summary', () => {
  const summary = {
    sessionId: uuid(300),
    userId: 'user-1',
    initialProfileId: uuid(1),
    startedAt: '2026-10-10T07:17:00.000Z',
    endedAt: '2026-10-10T09:31:00.000Z',
    stopReason: 'user' as const,
    durationMs: 134 * 60_000,
    stats: {
      triggers: 13,
      requests: 12,
      droppedActions: 0,
      playersFound: 9,
      playersNotFound: 1,
      recognitionFailures: 1,
      serviceErrors: 1,
    },
    repeatEncounters: 3,
    distinctRepeatedOpponents: 2,
  }

  it('appears after Stop, can be dismissed and restarts monitoring', async () => {
    await renderMain({
      monitor: monitorViewFixture({ state: 'STOPPED', runIntent: false, summary }),
    })
    expect(await screen.findByRole('heading', { name: 'Итоги сессии' })).toBeVisible()
    expect(screen.getByText(/2 ч 14 мин/)).toBeVisible()
    expect(screen.getByText('повторные соперники')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Начать снова' }))
    await waitFor(() => expect(bridge.crTools.startMonitor).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(
      screen.queryByRole('heading', { name: 'Итоги сессии' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Мониторинг остановлен', { selector: 'h2' })).toBeVisible()
  })

  it('is absent while monitoring runs or when no summary was finalized', async () => {
    await renderMain({ monitor: running({ summary }) })
    expect(await screen.findByText('Ждём бой', { selector: 'h2' })).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Итоги сессии' }),
    ).not.toBeInTheDocument()
    pushView(monitorViewFixture({ state: 'STOPPED', runIntent: false }))
    expect(
      await screen.findByText('Мониторинг остановлен', { selector: 'h2' }),
    ).toBeVisible()
  })
})

describe('history', () => {
  it('#14 retains the selected result when it leaves the live page and history failed', async () => {
    await renderMain({ monitor: running({ results: [found(1), found(2)] }) })
    bridge.crTools.getMonitorHistory.mockRejectedValue(new Error('IPC'))
    const history = await screen.findByRole('region', { name: 'История' })
    fireEvent.click(within(history).getByRole('button', { name: /Игрок2/ }))
    expect(screen.getByRole('heading', { name: 'Игрок2' })).toBeVisible()
    pushView(running({ results: [found(3)] }))
    expect(screen.getByRole('heading', { name: 'Игрок2' })).toBeVisible()
    expect(screen.getByRole('button', { name: /к текущему/ })).toBeVisible()
  })

  it('#20 highlights the latest shown result without requiring a history click', async () => {
    await renderMain({ monitor: running({ results: [found(1), found(2)] }) })
    const history = await screen.findByRole('region', { name: 'История' })
    expect(within(history).getByRole('button', { name: /Игрок1/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(history).getByRole('button', { name: /Игрок2/ })).not.toHaveAttribute(
      'aria-current',
    )
  })
  it('is clickable, shows a back banner and is not replaced by a push', async () => {
    await renderMain({
      monitor: running({
        results: [
          found(1),
          found(2, {
            player: { name: 'Lena', tag: '#8Y2QL0', rating: 2540, clan: 'Alpha' },
          }),
        ],
      }),
    })
    expect(await screen.findByRole('heading', { name: 'Игрок1' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /Lena/ }))
    expect(await screen.findByRole('heading', { name: 'Lena' })).toBeVisible()
    expect(screen.getByText('Просмотр прошлого результата')).toBeVisible()
    expect(screen.getByRole('button', { name: /Lena/ })).toHaveAttribute(
      'aria-current',
      'true',
    )

    // A new result is pushed: the opened entry stays on screen.
    pushView(
      running({
        results: [
          found(3, { player: { name: 'Fresh', tag: '#PPP', rating: 1, clan: null } }),
          found(1),
          found(2, {
            player: { name: 'Lena', tag: '#8Y2QL0', rating: 2540, clan: 'Alpha' },
          }),
        ],
      }),
    )
    expect(await screen.findByRole('button', { name: /Fresh/ })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Lena' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Fresh' })).not.toBeInTheDocument()
    expect(screen.getByText(/есть новый результат/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /Вернуться к текущему/ }))
    expect(await screen.findByRole('heading', { name: 'Fresh' })).toBeVisible()
    expect(screen.queryByText('Просмотр прошлого результата')).not.toBeInTheDocument()
  })

  it('loads older entries through getMonitorHistory and opens them', async () => {
    const older = Array.from({ length: 20 }, (_, i) =>
      failure(50 + i, 'player_not_found'),
    )
    await renderMain({
      monitor: running({ results: Array.from({ length: 20 }, (_, i) => found(i + 1)) }),
      history: older,
    })
    await waitFor(() =>
      expect(bridge.crTools.getMonitorHistory).toHaveBeenCalledWith({
        offset: 0,
        limit: 20,
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё' }))
    await waitFor(() =>
      expect(bridge.crTools.getMonitorHistory).toHaveBeenLastCalledWith({
        offset: 40,
        limit: 20,
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: /Ник69/ }))
    expect(await screen.findByText('Игрока нет в базе')).toBeVisible()
    expect(screen.getByText('Просмотр прошлого результата')).toBeVisible()
  })

  it('marks reprocessed entries as outside the session statistics', async () => {
    await renderMain({
      monitor: running({
        results: [
          found(1),
          found(2, {
            reprocessed: true,
            player: { name: 'Again', tag: '#PPP', rating: 1, clan: null },
          }),
        ],
      }),
    })
    const row = await screen.findByRole('button', { name: /Again/ })
    expect(within(row).getByText('Переобработано · вне статистики сессии')).toBeVisible()
    fireEvent.click(row)
    const header = await screen.findByRole('region', { name: 'Соперник' })
    expect(
      within(header).getByText('Переобработано · вне статистики сессии'),
    ).toBeVisible()
  })

  it('shows the session counters', async () => {
    await renderMain({
      monitor: running({
        stats: {
          triggers: 13,
          requests: 12,
          droppedActions: 0,
          playersFound: 9,
          playersNotFound: 1,
          recognitionFailures: 1,
          serviceErrors: 1,
        },
      }),
    })
    const stats = await screen.findByRole('region', { name: 'За сессию' })
    expect(within(stats).getByText('Сработок 13')).toBeVisible()
    expect(within(stats).getByText('9')).toBeVisible()
  })
})

describe('head-to-head block', () => {
  const lookupArg = (index: number): { requestId: string; opponentTag: string } =>
    bridge.crTools.h2h.lookup.mock.calls[index]?.[0] as unknown as {
      requestId: string
      opponentTag: string
    }

  it('requests the opponent tag, shows totals and the disclaimer, and cancels on change', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    expect(await screen.findByLabelText('Загружаем личные встречи')).toBeVisible()
    await waitFor(() => expect(bridge.crTools.h2h.lookup).toHaveBeenCalledOnce())
    const first = lookupArg(0)
    expect(first.opponentTag).toBe('#2Q8YLP0')
    expect(await screen.findByText('75% побед')).toBeVisible()
    expect(screen.getAllByText('по записанным боям Пути легенд').length).toBeGreaterThan(
      0,
    )
    expect(screen.getByText('3:0')).toBeVisible()

    // Another opponent: the previous request is cancelled, a fresh id is used.
    pushView(
      running({
        results: [
          found(2, { player: { name: 'Другой', tag: '#8Y2QL0', rating: 1, clan: null } }),
        ],
      }),
    )
    await waitFor(() => expect(bridge.crTools.h2h.lookup).toHaveBeenCalledTimes(2))
    expect(bridge.crTools.h2h.cancel).toHaveBeenCalledWith({ requestId: first.requestId })
    const second = lookupArg(1)
    expect(second.requestId).not.toBe(first.requestId)
    expect(second.opponentTag).toBe('#8Y2QL0')
  })

  it('cancels a pending request when the card unmounts', async () => {
    bridge = installBridge({ monitor: running({ results: [found(1)] }) })
    bridge.crTools.h2h.lookup.mockImplementation(() => new Promise(() => undefined))
    const view = render(<AppRoot />)
    await waitFor(() => expect(bridge.crTools.h2h.lookup).toHaveBeenCalledOnce())
    const { requestId } = lookupArg(0)
    view.unmount()
    expect(bridge.crTools.h2h.cancel).toHaveBeenCalledWith({ requestId })
  })

  it('does not ask for an opponent without a tag', async () => {
    const result = found(1, {
      player: { name: 'Без тега', tag: null, rating: 5, clan: null },
    })
    await renderMain({ monitor: running({ results: [result] }) })
    expect(await screen.findByText('Встречи недоступны')).toBeVisible()
    expect(bridge.crTools.h2h.lookup).not.toHaveBeenCalled()
  })

  it('shows «Нет записанных встреч» for none and never «никогда»', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    bridge.crTools.h2h.lookup.mockImplementation(({ requestId }: { requestId: string }) =>
      Promise.resolve({
        capability: 'supported',
        requestId,
        data: h2hData({
          status: 'none',
          totals: {
            meetings: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            decisiveMeetings: 0,
            winRate: null,
          },
          last: null,
          recent: [],
          perAccount: [],
        }),
      }),
    )
    pushView(running({ results: [found(5)] }))
    expect(await screen.findByText('Нет записанных встреч')).toBeVisible()
    expect(document.body).not.toHaveTextContent(/никогда/i)
  })

  it('invites to link an account and navigates to settings', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    bridge.crTools.h2h.lookup.mockImplementation(({ requestId }: { requestId: string }) =>
      Promise.resolve({
        capability: 'supported',
        requestId,
        data: h2hData({
          status: 'no_accounts',
          totals: {
            meetings: null,
            wins: null,
            losses: null,
            draws: null,
            decisiveMeetings: null,
            winRate: null,
          },
          last: null,
          recent: [],
          perAccount: [],
        }),
      }),
    )
    pushView(running({ results: [found(5)] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Привязать аккаунт' }))
    expect(
      await screen.findByRole('navigation', { name: 'Разделы настроек' }),
    ).toBeVisible()
  })

  it.each([
    ['rate_limited', 'H2H_RATE_LIMITED', 'Слишком много запросов'],
    ['unsupported', 'H2H_UNSUPPORTED', 'Сервер пока не поддерживает'],
    ['unavailable', 'H2H_REQUEST_FAILED', 'Сервер не ответил'],
  ])('shows a calm unavailable message for %s', async (capability, code, text) => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    bridge.crTools.h2h.lookup.mockImplementation(({ requestId }: { requestId: string }) =>
      Promise.resolve({ capability, requestId, retryAt: null, code }),
    )
    pushView(running({ results: [found(5)] }))
    expect(await screen.findByText('Личные встречи сейчас недоступны')).toBeVisible()
    expect(screen.getByText(new RegExp(text))).toBeVisible()
  })

  it('opens the full card with accounts and recent meetings', async () => {
    await renderMain({ monitor: running({ results: [found(1)] }) })
    fireEvent.click(await screen.findByRole('button', { name: /Все встречи/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('По аккаунтам')).toBeVisible()
    expect(within(dialog).getByText('Последние встречи')).toBeVisible()
    expect(within(dialog).getByText('4 встречи · победы : поражения')).toBeVisible()
  })
})

describe('tag palette', () => {
  it('shows the real head-to-head card for a valid tag and nothing for an invalid one', async () => {
    await renderMain()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const input = await screen.findByPlaceholderText('#2Q8YLP0')
    fireEvent.change(input, { target: { value: 'ZZZ' } })
    fireEvent.submit(input.closest('form') ?? input)
    expect(bridge.crTools.h2h.lookup).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '2q8ylp0' } })
    fireEvent.submit(input.closest('form') ?? input)
    await waitFor(() =>
      expect(bridge.crTools.h2h.lookup).toHaveBeenCalledWith(
        expect.objectContaining({ opponentTag: '#2Q8YLP0' }),
      ),
    )
    expect(await screen.findByText('75% побед')).toBeVisible()
    expect(document.body).not.toHaveTextContent(/не найден/i)
    fireEvent.click(screen.getByRole('button', { name: /Другой тег/ }))
    await waitFor(() => expect(bridge.crTools.h2h.cancel).toHaveBeenCalled())
  })
})

describe('mini window', () => {
  it('opens the history as a sheet from the strip', async () => {
    window.innerWidth = 500
    await renderMain({ monitor: running({ results: [found(1)] }) })
    expect(await screen.findByRole('heading', { name: 'Игрок1' })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'История' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /История/ }))
    expect(await screen.findByRole('region', { name: 'История' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'За сессию' })).toBeVisible()
  })
})
