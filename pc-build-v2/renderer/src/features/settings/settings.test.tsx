// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StreamerCommand } from '../../../../shared/contracts/streamer-ipc'
import type { UpdateView } from '../../../../shared/models/update'
import { describeCommandError } from '../streamer/text'
import { failure, mountStream, ok, type StreamWorld } from '../../test/streamerWorld'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const settings = (section: 'app' | 'overlay' | 'accounts' | 'updates') =>
  ({ name: 'settings', section }) as const

const commandsOf = (world: StreamWorld, action: string): StreamerCommand[] =>
  world.fake.command.mock.calls
    .map(([command]) => command)
    .filter((c) => c.action === action)

describe('settings: application', () => {
  it('#18 reports malformed stored tags instead of throwing in account actions', async () => {
    const world = mountStream(settings('accounts'), {
      view: (view) => {
        const account = view.title.accounts[2]
        if (account !== undefined) account.tag = 'BAD'
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Включить' }))
    expect(
      await screen.findByText(describeCommandError('ACCOUNT_TAG_INVALID')),
    ).toBeVisible()
    expect(world.fake.command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт Запасной' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить аккаунт' }))
    expect(
      within(dialog).getByText(describeCommandError('ACCOUNT_TAG_INVALID')),
    ).toBeVisible()
    expect(world.fake.command).not.toHaveBeenCalled()
  })
  it('saves every switch the moment it changes, without a save button', async () => {
    const world = mountStream(settings('app'))
    const toggle = await screen.findByRole('switch', {
      name: 'Начинать мониторинг при запуске',
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(world.bridge.crTools.updateAppSettings).toHaveBeenCalledWith({
        autoStartMonitoring: false,
      }),
    )
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(screen.queryByRole('button', { name: /Сохранить/ })).toBeNull()
    expect(await screen.findByText('Сохранено')).toBeVisible()

    fireEvent.click(screen.getByRole('switch', { name: 'Запускать вместе с Windows' }))
    fireEvent.click(
      screen.getByRole('switch', { name: 'Закрытие окна сворачивает в трей' }),
    )
    fireEvent.click(
      screen.getByRole('switch', { name: 'Сообщать о найденном сопернике' }),
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Уменьшить анимацию' }))
    await waitFor(() =>
      expect(world.bridge.crTools.updateAppSettings).toHaveBeenCalledTimes(5),
    )
    const patches = world.bridge.crTools.updateAppSettings.mock.calls.map(
      ([patch]) => patch,
    )
    expect(patches).toEqual(
      expect.arrayContaining([
        { launchAtStartup: true },
        { closeToTray: false },
        { notifyOpponentFound: false },
        { reducedMotion: true },
      ]),
    )
    await waitFor(() =>
      expect(document.documentElement.dataset['reducedMotion']).toBe('true'),
    )
  })

  it('shows the pending state while saving and the previous value after a failure', async () => {
    const world = mountStream(settings('app'))
    const gate = Promise.withResolvers<never>()
    world.bridge.crTools.updateAppSettings.mockImplementationOnce(() => gate.promise)
    const toggle = await screen.findByRole('switch', {
      name: 'Закрытие окна сворачивает в трей',
    })
    fireEvent.click(toggle)
    // Pending: shows the chosen value and cannot be clicked again.
    await waitFor(() => expect(toggle).toBeDisabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    gate.reject(new Error('ipc'))
    expect(
      await screen.findByText(
        'Не удалось сохранить настройку. Прежнее значение осталось.',
      ),
    ).toBeVisible()
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('opens the log folder and reports when it could not', async () => {
    const world = mountStream(settings('app'))
    world.bridge.crTools.openLogFolder.mockResolvedValueOnce({ opened: false })
    fireEvent.click(await screen.findByRole('button', { name: 'Открыть папку журналов' }))
    expect(await screen.findByText('Не удалось открыть папку журналов.')).toBeVisible()
  })
})

describe('settings: overlay', () => {
  it('saves the same fields as the tray immediately and toggles the window', async () => {
    const world = mountStream(settings('overlay'))
    const api = world.bridge.crTools.updateWidgetSettings
    fireEvent.click(await screen.findByRole('switch', { name: 'Поверх всех окон' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Закрепить окно' }))
    fireEvent.click(screen.getByRole('button', { name: 'Компактное' }))
    await waitFor(() => expect(api.mock.calls).toHaveLength(3))
    expect(api.mock.calls.map(([patch]) => patch)).toEqual([
      { alwaysOnTop: false },
      { locked: true },
      { compactMode: true },
    ])
    // Width now edits the compact width.
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Ширина окна' })).getByRole(
        'button',
        {
          name: 'Увеличить',
        },
      ),
    )
    await waitFor(() => expect(api.mock.calls.at(-1)?.[0]).toEqual({ compactWidth: 540 }))

    fireEvent.click(screen.getByRole('button', { name: 'Показать окно' }))
    expect(await screen.findByRole('button', { name: 'Скрыть окно' })).toBeVisible()
  })

  it('reports a failed save and keeps the previous value', async () => {
    const world = mountStream(settings('overlay'))
    world.bridge.crTools.updateWidgetSettings.mockRejectedValueOnce(new Error('ipc'))
    const toggle = await screen.findByRole('switch', { name: 'Закрепить окно' })
    fireEvent.click(toggle)
    expect(
      await screen.findByText('Не удалось сохранить. Прежнее значение осталось.'),
    ).toBeVisible()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})

describe('settings: accounts', () => {
  async function fillAndSubmit(tag: string, alias: string): Promise<void> {
    fireEvent.change(await screen.findByRole('textbox', { name: 'Тег Clash Royale' }), {
      target: { value: tag },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Название (необязательно)' }), {
      target: { value: alias },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
  }

  it('lists accounts with their state and adds one', async () => {
    const world = mountStream(settings('accounts'))
    expect(await screen.findByText('Твинк')).toBeVisible()
    expect(screen.getByText('играет сейчас')).toBeVisible()
    expect(screen.getByText('отключён')).toBeVisible()
    await fillAndSubmit('8y2ql0', 'Новый')
    await waitFor(() =>
      expect(commandsOf(world, 'accounts.add')).toEqual([
        { action: 'accounts.add', tag: '#8Y2QL0', alias: 'Новый' },
      ]),
    )
    expect(await screen.findByText('Аккаунт добавлен')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Тег Clash Royale' })).toHaveValue('')
  })

  it.each([
    ['ACCOUNT_TAG_INVALID', /Тег записан неверно/, true],
    ['ACCOUNT_NOT_FOUND', /Такого игрока нет в Clash Royale/, true],
    ['ACCOUNT_LIMIT_REACHED', /Достигнут предел — 20 аккаунтов/, false],
    ['CLASH_API_UNAVAILABLE', /Сервер Clash Royale сейчас не отвечает/, false],
    ['ACCOUNT_SAVE_UNAVAILABLE', /Сервер не смог сохранить аккаунт/, false],
  ] as const)(
    'shows %s as clear Russian text and keeps the form draft',
    async (code, text, atField) => {
      const world = mountStream(settings('accounts'))
      world.fake.handlers.push((command) =>
        command.action === 'accounts.add' ? failure(code) : undefined,
      )
      await fillAndSubmit('#8Y2QL0', 'Черновик')
      const message = await screen.findByText(text)
      expect(message).toBeVisible()
      expect(describeCommandError(code)).toMatch(text)
      // Tag problems sit under the tag field; the rest in the form banner.
      if (atField) expect(message.closest('[role="alert"]')).not.toBeNull()
      expect(screen.getByRole('textbox', { name: 'Тег Clash Royale' })).toHaveValue(
        '#8Y2QL0',
      )
      expect(
        screen.getByRole('textbox', { name: 'Название (необязательно)' }),
      ).toHaveValue('Черновик')
    },
  )

  it('checks the tag before sending and refuses duplicates', async () => {
    const world = mountStream(settings('accounts'))
    await fillAndSubmit('#8Y2-QL0', '')
    expect(await screen.findByText(/Тег записан неверно/)).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Тег Clash Royale' }), {
      target: { value: '#88299RC9Y' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
    expect(await screen.findByText('Аккаунт #88299RC9Y уже добавлен.')).toBeVisible()
    expect(commandsOf(world, 'accounts.add')).toHaveLength(0)
  })

  it('tells about a title that Twitch did not take after an account change', async () => {
    const world = mountStream(settings('accounts'))
    world.fake.handlers.push((command) =>
      command.action === 'accounts.add'
        ? ok(structuredClone(world.fake.view), { warnings: ['TITLE_UPDATE_FAILED'] })
        : undefined,
    )
    await fillAndSubmit('#8Y2QL0', '')
    expect(
      await screen.findByText(/Сохранено, но Twitch не принял название/),
    ).toBeVisible()
  })

  it('re-enables a disabled account and removes one only after confirmation', async () => {
    const world = mountStream(settings('accounts'))
    fireEvent.click(await screen.findByRole('button', { name: 'Включить' }))
    await waitFor(() =>
      expect(commandsOf(world, 'accounts.reenable')).toEqual([
        { action: 'accounts.reenable', tag: '#9PQ0L2YVV' },
      ]),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить аккаунт Твинк' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Удалить «Твинк»?' })
    expect(commandsOf(world, 'accounts.remove')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить аккаунт' }))
    await waitFor(() =>
      expect(commandsOf(world, 'accounts.remove')).toEqual([
        { action: 'accounts.remove', tag: '#22LUPYCYC' },
      ]),
    )
    await waitFor(() => expect(screen.queryByText('Твинк')).toBeNull())
  })

  it('explains honestly that other roles cannot manage accounts yet', async () => {
    const world = mountStream(settings('accounts'), { roles: ['user'] })
    expect(await screen.findByText('Пока доступно только стримерам')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Тег Clash Royale' })).toBeNull()
    expect(world.fake.command).not.toHaveBeenCalled()
  })
})

const available: UpdateView = {
  state: 'AVAILABLE',
  currentVersion: '2.5.0',
  availableVersion: '2.6.0',
  critical: false,
  releaseNotes: ['Профили стали быстрее', 'Оверлей показывает до пяти колод'],
  progress: null,
  error: null,
}

describe('settings: updates', () => {
  it('shows the version, notes and downloads the update', async () => {
    const world = mountStream(settings('updates'), { update: available })
    expect(await screen.findByText('Версия 2.6.0')).toBeVisible()
    expect(screen.getByText('Сейчас установлена 2.5.0')).toBeVisible()
    expect(screen.getByText('Профили стали быстрее')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Скачать и обновить' }))
    await waitFor(() =>
      expect(world.bridge.crTools.downloadUpdate).toHaveBeenCalledTimes(1),
    )
  })

  it('shows progress with bytes and cancels the download', async () => {
    const world = mountStream(settings('updates'), {
      update: {
        ...available,
        state: 'DOWNLOADING',
        progress: {
          downloadedBytes: 56 * 1048576,
          totalBytes: 148 * 1048576,
          percent: 38,
        },
      },
    })
    expect(await screen.findByText('Скачано 56 МБ из 148 МБ')).toBeVisible()
    expect(screen.getAllByText('38%').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Отменить загрузку' }))
    await waitFor(() =>
      expect(world.bridge.crTools.cancelUpdate).toHaveBeenCalledTimes(1),
    )
  })

  it('installs a downloaded update', async () => {
    const world = mountStream(settings('updates'), {
      update: { ...available, state: 'READY' },
    })
    fireEvent.click(
      within(
        await screen.findByRole('region', { name: 'Обновление приложения' }),
      ).getByRole('button', { name: 'Перезапустить для установки' }),
    )
    await waitFor(() =>
      expect(world.bridge.crTools.installUpdate).toHaveBeenCalledTimes(1),
    )
  })

  it('shows a failed update with its message and offers a retry', async () => {
    const world = mountStream(settings('updates'), {
      update: {
        ...available,
        state: 'FAILED',
        error: {
          code: 'DOWNLOAD_FAILED',
          message: 'Нет связи с сервером обновлений.',
          retryable: true,
        },
      },
    })
    expect(await screen.findByText('Обновление не удалось')).toBeVisible()
    expect(screen.getAllByText(/Нет связи с сервером обновлений/).length).toBeGreaterThan(
      0,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }))
    await waitFor(() =>
      expect(world.bridge.crTools.downloadUpdate).toHaveBeenCalledTimes(1),
    )
  })

  it('checks for updates when nothing is new', async () => {
    const world = mountStream(settings('updates'))
    expect(await screen.findByText('Обновления ещё не проверялись')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Проверить обновления' }))
    await waitFor(() =>
      expect(world.bridge.crTools.checkForUpdate).toHaveBeenCalledTimes(1),
    )
  })
})
