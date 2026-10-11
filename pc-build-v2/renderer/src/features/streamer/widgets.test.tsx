// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  StreamerCommand,
  StreamerCommandResult,
} from '../../../../shared/contracts/streamer-ipc'
import { failure, mountStream, ok, type StreamWorld } from '../../test/streamerWorld'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const WIDGETS = { name: 'stream', section: 'widgets' } as const

const commandsOf = (world: StreamWorld, action: string): StreamerCommand[] =>
  world.fake.command.mock.calls
    .map(([command]) => command)
    .filter((c) => c.action === action)

describe('OBS widgets: preview frame', () => {
  it('loads the token-free preview URL, then shows it centred inside a sandboxed frame', async () => {
    mountStream(WIDGETS)
    const frame = await screen.findByTitle('Предпросмотр: Карточка соперника')
    const url = new URL(frame.getAttribute('src') ?? '')
    expect(url.origin).toBe('https://api.artcsworld.xyz')
    expect(url.pathname).toBe('/opponent-widget')
    expect(url.searchParams.get('mock')).toBe('1')
    expect([...url.searchParams.keys()]).not.toContain('key')
    expect(frame.getAttribute('src')).not.toContain('••••')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(screen.getByText('Загружаем предпросмотр…')).toBeVisible()
    fireEvent.load(frame)
    await waitFor(() =>
      expect(screen.queryByText('Загружаем предпросмотр…')).not.toBeInTheDocument(),
    )
    expect(frame.style.visibility).toBe('visible')
    expect(frame.style.transform).toContain('translate(-50%, -50%)')
  })

  it('shows an error when the frame never loads, with a retry that starts loading again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mountStream(WIDGETS)
      await screen.findByTitle('Предпросмотр: Карточка соперника')
      expect(screen.getByText('Загружаем предпросмотр…')).toBeVisible()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_000)
      })
      expect(await screen.findByText('Не удалось загрузить предпросмотр')).toBeVisible()
      expect(screen.getByText(/Сами виджеты в OBS это не затрагивает/)).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: /Повторить/ }))
      expect(await screen.findByText('Загружаем предпросмотр…')).toBeVisible()
    } finally {
      vi.useRealTimers()
    }
  })

  it('switches the preview to the statistics widget', async () => {
    mountStream(WIDGETS)
    await screen.findByTitle('Предпросмотр: Карточка соперника')
    fireEvent.click(screen.getByRole('button', { name: 'Статистика' }))
    const frame = await screen.findByTitle('Предпросмотр: Статистика стримера')
    expect(frame.getAttribute('src')).toContain('/streamer-stats-widget?')
  })
})

describe('OBS widgets: links', () => {
  it('explains a missing link and disables copying it', async () => {
    mountStream(WIDGETS, {
      view: (view) => {
        view.overlay.urlsAvailable.opponent = false
        view.overlay.maskedUrls.opponent = null
      },
    })
    expect(await screen.findByText('Сервер ещё не выдал ссылки')).toBeVisible()
    expect(screen.getByText('Ссылка пока не создана')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Скопировать ссылку: Карточка соперника' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Скопировать ссылку: Статистика стримера' }),
    ).toBeEnabled()
  })

  it('copies through the command, never exposing the URL to the page', async () => {
    const world = mountStream(WIDGETS)
    expect(
      await screen.findByText(/artcsworld\.xyz\/opponent-widget\?key=••••/),
    ).toBeVisible()
    fireEvent.click(
      screen.getByRole('button', { name: 'Скопировать ссылку: Карточка соперника' }),
    )
    await waitFor(() =>
      expect(world.fake.command).toHaveBeenCalledWith({
        action: 'widget.copy',
        kind: 'opponent',
      }),
    )
    expect(await screen.findByText('Ссылка скопирована')).toBeVisible()
  })

  it('says what happened when copying fails', async () => {
    const world = mountStream(WIDGETS)
    world.fake.handlers.push((command) =>
      command.action === 'widget.copy' ? failure('OVERLAY_URL_UNAVAILABLE') : undefined,
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Скопировать ссылку: Статистика стримера',
      }),
    )
    expect(await screen.findByText(/Сервер ещё не выдал ссылку для OBS/)).toBeVisible()
  })
})

describe('OBS widgets: key reset', () => {
  it('asks first and sends the confirmed command only after the user agrees', async () => {
    const world = mountStream(WIDGETS)
    fireEvent.click(await screen.findByRole('button', { name: 'Сменить ключ…' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Сменить ключ доступа?',
    })
    expect(commandsOf(world, 'widget.resetToken')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(commandsOf(world, 'widget.resetToken')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Сменить ключ…' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Сменить ключ',
      }),
    )
    await waitFor(() =>
      expect(commandsOf(world, 'widget.resetToken')).toEqual([
        { action: 'widget.resetToken', confirmed: true },
      ]),
    )
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('keeps the dialog open with the real error when the reset fails', async () => {
    const world = mountStream(WIDGETS)
    world.fake.handlers.push((command) =>
      command.action === 'widget.resetToken' ? failure('SERVER_ERROR') : undefined,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Сменить ключ…' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сменить ключ' }))
    expect(
      await within(dialog).findByText(/На сервере что-то пошло не так/),
    ).toBeVisible()
    expect(screen.getByRole('alertdialog')).toBeVisible()
  })
})

describe('OBS widgets: settings save at once, in order, without overwriting each other', () => {
  it('merges edits made while a save is running into the next save', async () => {
    const world = mountStream(WIDGETS)
    const release: (() => void)[] = []
    world.fake.handlers.push((command): Promise<StreamerCommandResult> | undefined => {
      if (command.action !== 'widget.settings') return undefined
      const gate = Promise.withResolvers<StreamerCommandResult>()
      release.push(() => {
        world.fake.view.overlay.settings = command.settings
        gate.resolve(ok(structuredClone(world.fake.view)))
      })
      return gate.promise
    })
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Показывать: Карточка соперника' }),
    )
    fireEvent.click(
      screen.getByRole('switch', { name: 'Показывать: Статистика стримера' }),
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Виджеты включены' }))
    await waitFor(() => expect(release).toHaveLength(1))
    // The first save is in flight; the others are waiting behind it.
    expect(commandsOf(world, 'widget.settings')).toHaveLength(1)
    release.shift()?.()
    await waitFor(() => expect(release).toHaveLength(1))
    release.shift()?.()
    await waitFor(() =>
      expect(commandsOf(world, 'widget.settings').length).toBeGreaterThanOrEqual(2),
    )
    const last = commandsOf(world, 'widget.settings').at(-1)
    if (last?.action !== 'widget.settings') throw new Error('expected widget.settings')
    expect(last.settings).toMatchObject({
      opponentEnabled: false,
      streamerStatsEnabled: false,
      enabled: false,
    })
    expect(
      screen.getByRole('switch', { name: 'Показывать: Карточка соперника' }),
    ).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps the edit visible on failure and retries it', async () => {
    const world = mountStream(WIDGETS)
    let attempts = 0
    world.fake.handlers.push((command) =>
      command.action === 'widget.settings' && attempts++ === 0
        ? failure('NETWORK_UNAVAILABLE')
        : undefined,
    )
    const toggle = await screen.findByRole('switch', {
      name: 'Показывать: Статистика стримера',
    })
    fireEvent.click(toggle)
    expect(await screen.findByText(/Нет связи с сервером/)).toBeVisible()
    expect(screen.getByText(/Изменения остались в форме/)).toBeVisible()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(commandsOf(world, 'widget.settings')).toHaveLength(2))
    await waitFor(() => expect(screen.queryByText(/Нет связи с сервером/)).toBeNull())
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('does not send an invalid manual account and says why', async () => {
    const world = mountStream(WIDGETS)
    fireEvent.click(await screen.findByRole('button', { name: 'Статистика' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Вручную' }))
    expect(
      await screen.findByText(/Выберите аккаунт, статистика которого пойдёт в виджет/),
    ).toBeVisible()
    expect(commandsOf(world, 'widget.settings')).toHaveLength(0)
    fireEvent.change(screen.getByRole('combobox', { name: 'Аккаунт для статистики' }), {
      target: { value: '#88299RC9Y' },
    })
    await waitFor(() => expect(commandsOf(world, 'widget.settings')).toHaveLength(1))
  })
})

describe('overview', () => {
  it('shows the foundations and sends the fix of a missing one to its home', async () => {
    mountStream(
      { name: 'stream', section: 'overview' },
      { readiness: { resultZonesConfigured: false } },
    )
    expect(await screen.findByText('Основа')).toBeVisible()
    expect(screen.getByText('не настроены в профиле')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Настроить в профиле' }))
    expect(await screen.findByRole('dialog', { name: 'Профили' })).toBeVisible()
  })

  it('toggles deck sharing and the widgets from the feature rows', async () => {
    const world = mountStream({ name: 'stream', section: 'overview' })
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Отправлять колоды в чат' }),
    )
    await waitFor(() =>
      expect(world.fake.command).toHaveBeenCalledWith({
        action: 'chat.toggle',
        enabled: true,
      }),
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Показывать: Соперник' }))
    await waitFor(() => expect(commandsOf(world, 'widget.settings')).toHaveLength(1))
    fireEvent.click(
      screen.getByRole('button', { name: 'Скопировать ссылку: Статистика' }),
    )
    await waitFor(() =>
      expect(world.fake.command).toHaveBeenCalledWith({
        action: 'widget.copy',
        kind: 'stats',
      }),
    )
  })

  it('shows partial server data as a notice and keeps the rest', async () => {
    mountStream(
      { name: 'stream', section: 'overview' },
      {
        view: (view) => {
          view.refresh.state = 'partial'
          view.refresh.errors = [
            {
              section: 'twitch',
              error: { code: 'NETWORK_UNAVAILABLE', message: 'x' },
            },
          ]
        },
      },
    )
    expect(await screen.findByText('Часть данных не обновилась')).toBeVisible()
    expect(screen.getByText(/Не получили: Twitch/)).toBeVisible()
    expect(screen.getByText('Основа')).toBeVisible()
  })
})
