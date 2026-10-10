// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { monitorViewFixture } from '../../../tests/monitor-fixtures'
import { authFixture, installBridge, profilesFixture, type Bridge } from '../test/bridge'
import { AppRoot } from './AppRoot'

let bridge: Bridge

async function renderApp(
  options: Parameters<typeof installBridge>[0] = {},
  route?: Parameters<typeof AppRoot>[0]['initialRoute'],
): Promise<void> {
  bridge = installBridge(options)
  render(route === undefined ? <AppRoot /> : <AppRoot initialRoute={route} />)
  await screen.findByRole('navigation', { name: 'Главная панель' })
}

describe('shell routing', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-reduced-motion')
  })

  it('shows the command bar on every page and navigates to settings with its own navigation', async () => {
    await renderApp()
    await screen.findByText('Ждём бой', { selector: 'h2' })
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    expect(
      await screen.findByRole('navigation', { name: 'Разделы настроек' }),
    ).toBeVisible()
    expect(screen.getByRole('navigation', { name: 'Главная панель' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Обновления/ }))
    expect(screen.getByRole('heading', { level: 1, name: 'Обновления' })).toBeVisible()
  })

  it('opens the tag palette with Ctrl+K and validates the tag', async () => {
    await renderApp()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Проверить тег' })
    const input = within(dialog).getByRole('textbox', { name: 'Проверить тег' })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'ZZZ' } })
    expect(within(dialog).getByText(/Тег состоит из цифр и букв/)).toBeVisible()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('creates a profile from the first-run state through the setup route', async () => {
    await renderApp({ profiles: profilesFixture([]), monitor: monitorViewFixture() })
    expect(await screen.findByText('Давайте настроим CR Tools')).toBeVisible()
    const create = screen.getAllByRole('button', { name: 'Создать профиль' })
    fireEvent.click(create[create.length - 1] ?? document.body)
    expect(await screen.findByText('Настройка профиля')).toBeVisible()
    // Setup is full-window: no command bar.
    expect(
      screen.queryByRole('navigation', { name: 'Главная панель' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    expect(await screen.findByText('Давайте настроим CR Tools')).toBeVisible()
  })
})

describe('role gating', () => {
  it('hides Игра/Стрим for a player and redirects a direct stream route to Игра', async () => {
    await renderApp(
      { auth: authFixture(['user']) },
      { name: 'stream', section: 'overview' },
    )
    expect(await screen.findByText('Ждём бой', { selector: 'h2' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Стрим' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Разделы стрима' }),
    ).not.toBeInTheDocument()
  })

  it('shows the streamer area with grouped left navigation to a streamer', async () => {
    await renderApp({ auth: authFixture(['user', 'streamer']) })
    fireEvent.click(await screen.findByRole('button', { name: 'Стрим' }))
    const nav = await screen.findByRole('navigation', { name: 'Разделы стрима' })
    for (const label of [
      'Обзор',
      'Twitch-канал',
      'Прогнозы',
      'Название стрима',
      'Колоды в чат',
      'Виджеты для OBS',
    ])
      expect(within(nav).getByRole('button', { name: new RegExp(label) })).toBeVisible()
    // Connections are a separate group from features; accounts live in settings.
    expect(within(nav).getByText('Подключения')).toBeVisible()
    expect(within(nav).getByText('Функции')).toBeVisible()
    fireEvent.click(within(nav).getByRole('button', { name: /Аккаунты Clash Royale/ }))
    expect(
      await screen.findByRole('navigation', { name: 'Разделы настроек' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Игра' }))
    await screen.findByText('Ждём бой', { selector: 'h2' })
  })
})

describe('partial bootstrap', () => {
  it('shows an own error for the failing resource and keeps the rest usable, then retries', async () => {
    await renderApp({ failing: ['profiles'] })
    expect(await screen.findByText('Не загрузилось: профили')).toBeVisible()
    expect(bridge.crTools.reportBootstrapFailure).toHaveBeenCalledWith({
      capability: 'profiles',
      code: 'IPC_FAILED',
    })
    // Monitor, auth and update controls stay usable.
    expect(screen.getByRole('button', { name: /Профили недоступны/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Аккаунт ArtCS' })).toBeVisible()
    expect(screen.queryByText('Не загрузилось: мониторинг')).not.toBeInTheDocument()

    bridge.recover()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() =>
      expect(screen.queryByText('Не загрузилось: профили')).not.toBeInTheDocument(),
    )
    expect(await screen.findByRole('button', { name: 'Профиль: Основной' })).toBeVisible()
    // The private rejection message never reaches the UI.
    expect(document.body.textContent).not.toContain('IPC_FAILED')
  })

  it('keeps the last good monitor view when a later reload fails', async () => {
    await renderApp()
    await screen.findByText('Ждём бой', { selector: 'h2' })
    bridge.crTools.getMonitorView.mockRejectedValue(new Error('IPC_FAILED'))
    bridge.crTools.getAppSnapshot.mockRejectedValue(new Error('IPC_FAILED'))
    // A pushed view still applies after a failed reload.
    act(() =>
      bridge.push(monitorViewFixture({ state: 'WAITING_SOURCE', runIntent: true })),
    )
    expect(await screen.findByText('Ждём окно игры…', { selector: 'h2' })).toBeVisible()
  })
})

describe('monitor ownership and continuity', () => {
  it('subscribes once, never starts or stops on mount or route change, and unsubscribes on unmount', async () => {
    bridge = installBridge({ auth: authFixture(['user', 'streamer']) })
    const view = render(<AppRoot />)
    await screen.findByRole('navigation', { name: 'Главная панель' })
    await screen.findByText('Ждём бой', { selector: 'h2' })

    fireEvent.click(screen.getByRole('button', { name: 'Стрим' }))
    await screen.findByRole('navigation', { name: 'Разделы стрима' })
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    await screen.findByRole('navigation', { name: 'Разделы настроек' })
    fireEvent.click(screen.getByRole('button', { name: 'Игра' }))
    await screen.findByText('Ждём бой', { selector: 'h2' })

    expect(bridge.crTools.onMonitorViewChanged).toHaveBeenCalledTimes(1)
    expect(bridge.crTools.startMonitor).not.toHaveBeenCalled()
    expect(bridge.crTools.stopMonitor).not.toHaveBeenCalled()

    // A push while on another route is visible immediately on return.
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    act(() =>
      bridge.push(monitorViewFixture({ state: 'WAITING_SOURCE', runIntent: true })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Игра' }))
    expect(await screen.findByText('Ждём окно игры…', { selector: 'h2' })).toBeVisible()

    view.unmount()
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1)
    expect(bridge.crTools.stopMonitor).not.toHaveBeenCalled()
  })

  it('Start and Stop buttons call the real commands', async () => {
    await renderApp({ monitor: monitorViewFixture() })
    const bar = await screen.findByRole('navigation', { name: 'Главная панель' })
    fireEvent.click(within(bar).getByRole('button', { name: 'Начать мониторинг' }))
    await waitFor(() => expect(bridge.crTools.startMonitor).toHaveBeenCalledTimes(1))
    // The monitor view after start() is "READY" for Stop.
    act(() => bridge.push(monitorViewFixture({ state: 'READY', runIntent: true })))
    fireEvent.click(await screen.findByRole('button', { name: 'Остановить' }))
    await waitFor(() => expect(bridge.crTools.stopMonitor).toHaveBeenCalledTimes(1))
  })

  it('keeps Stop (not a failure) while waiting for the game window', async () => {
    await renderApp({
      monitor: monitorViewFixture({ state: 'WAITING_SOURCE', runIntent: true }),
    })
    // Stop is in the command bar and, calmly, in the waiting card itself.
    expect(await screen.findAllByRole('button', { name: 'Остановить' })).toHaveLength(2)
    expect(screen.queryByText('Не удалось запустить')).not.toBeInTheDocument()
  })
})

describe('global wiring', () => {
  it('wires the update strip to the real updater and its download command', async () => {
    await renderApp({
      update: {
        state: 'AVAILABLE',
        currentVersion: '0.1.23',
        availableVersion: '0.2.0',
        critical: false,
        releaseNotes: ['Новый оверлей'],
        progress: null,
        error: null,
      },
    })
    expect(await screen.findByText('Доступна версия 0.2.0')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Что нового' }))
    expect(await screen.findByText('Новый оверлей')).toBeVisible()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /Обновить/ }))
    await waitFor(() => expect(bridge.crTools.downloadUpdate).toHaveBeenCalledTimes(1))
  })

  it('window controls go through crTools.window.command', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть окно' }))
    fireEvent.click(screen.getByRole('button', { name: 'Развернуть окно' }))
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть окно' }))
    const actions = bridge.crTools.window.command.mock.calls.map(
      (call) => call[0] as string,
    )
    expect(actions).toEqual(
      expect.arrayContaining(['get', 'minimize', 'maximize', 'close']),
    )
  })

  it('logout confirmation runs the real logout and keeps the dialog on failure', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Аккаунт ArtCS' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Выйти из аккаунта/ }))
    expect(
      await screen.findByRole('alertdialog', { name: 'Выйти из аккаунта?' }),
    ).toBeVisible()
    bridge.crTools.logout.mockRejectedValueOnce(new Error('x'))
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))
    expect(
      await screen.findByText('Не удалось выйти из аккаунта. Повторите операцию.'),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(bridge.crTools.logout).toHaveBeenCalledTimes(2)
  })

  it('applies reduced motion from app settings to the document', async () => {
    bridge = installBridge()
    bridge.crTools.getAppSettings.mockResolvedValue({
      reducedMotion: true,
      launchAtStartup: false,
      diagnosticsEnabled: false,
      autoStartMonitoring: true,
      closeToTray: true,
      notifyOpponentFound: true,
    })
    render(<AppRoot />)
    await waitFor(() =>
      expect(document.documentElement.dataset['reducedMotion']).toBe('true'),
    )
  })
})
