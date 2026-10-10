// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  StreamerCommand,
  StreamerCommandResult,
} from '../../../../shared/contracts/streamer-ipc'
import { failure, installStream, mountStream, ok } from '../../test/streamerWorld'
import { StreamerProvider } from './StreamerProvider'
import { useStreamer } from './streamerContext'
import type { CommandOutcome, StreamerController } from './useStreamerController'

const holder: { current: StreamerController | null } = { current: null }
function ctl(): StreamerController {
  if (holder.current === null) throw new Error('controller not mounted')
  return holder.current
}

afterEach(() => {
  holder.current = null
  cleanup()
  vi.restoreAllMocks()
})

function Probe({ onController }: { onController: (c: StreamerController) => void }) {
  onController(useStreamer())
  return null
}

function parentOf(element: HTMLElement): HTMLElement {
  if (element.parentElement === null) throw new Error('no parent')
  return element.parentElement
}

describe('streamer controller: serial and coalesced commands', () => {
  it('runs commands one at a time and collapses waiting commands with the same key', async () => {
    const world = installStream()
    const release: (() => void)[] = []
    const started: string[] = []
    world.fake.handlers.push((command) => {
      if (command.action !== 'chat.toggle') return undefined
      started.push(`chat:${String(command.enabled)}`)
      const gate = Promise.withResolvers<StreamerCommandResult>()
      release.push(() => {
        world.fake.view.deckSharing.enabled = command.enabled
        gate.resolve(ok(structuredClone(world.fake.view)))
      })
      return gate.promise
    })
    render(
      <StreamerProvider enabled>
        <Probe onController={(value) => (holder.current = value)} />
      </StreamerProvider>,
    )
    await waitFor(() => expect(holder.current?.view).not.toBeNull())

    const outcomes: Promise<CommandOutcome>[] = []
    act(() => {
      const send = (enabled: boolean): void => {
        outcomes.push(ctl().command({ action: 'chat.toggle', enabled }, { key: 'chat' }))
      }
      send(true) // starts at once
      send(false) // waits
      send(true) // replaces the waiting one
    })
    await waitFor(() => expect(started).toEqual(['chat:true']))
    // Nothing else starts while the first is in flight.
    await Promise.resolve()
    expect(world.fake.command).toHaveBeenCalledTimes(1)
    expect(ctl().busy).toBe(true)

    await act(async () => {
      release.shift()?.()
      await outcomes[0]
    })
    await waitFor(() => expect(started).toEqual(['chat:true', 'chat:true']))
    await expect(outcomes[1]).resolves.toEqual({ status: 'superseded' })
    await act(async () => {
      release.shift()?.()
      await outcomes[2]
    })
    expect(world.fake.command).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(ctl().busy).toBe(false))
  })

  it('reports a rejected bridge call as a failed outcome and keeps the last good view', async () => {
    const world = installStream()
    world.fake.command.mockRejectedValueOnce(new Error('ipc'))
    render(
      <StreamerProvider enabled>
        <Probe onController={(value) => (holder.current = value)} />
      </StreamerProvider>,
    )
    await waitFor(() => expect(holder.current?.view).not.toBeNull())
    let outcome: CommandOutcome | null = null
    await act(async () => {
      outcome = await ctl().command({ action: 'predictions.stop' })
    })
    expect(outcome).toEqual({ status: 'failed', code: 'IPC_FAILED', detail: null })
    expect(ctl().view?.twitch.username).toBe('artcs_cr')
  })
})

describe('requirements link to the owning page', () => {
  it('predictions: Twitch → Twitch page, zones → profiles panel, monitoring → start', async () => {
    const world = mountStream(
      { name: 'stream', section: 'predictions' },
      {
        readiness: {
          twitchConnected: false,
          resultZonesConfigured: false,
          monitoring: false,
        },
      },
    )
    const needs = await screen.findByText('Нужно для работы')
    const block = parentOf(needs)
    expect(within(block).getByText('не подключён')).toBeVisible()
    expect(within(block).getByText('не настроены в профиле')).toBeVisible()
    expect(within(block).getByText('не запущен')).toBeVisible()
    // The start button is blocked while something is missing.
    expect(screen.getByRole('button', { name: /Включить прогнозы/ })).toBeDisabled()

    fireEvent.click(within(block).getByRole('button', { name: /Запустить/ }))
    await waitFor(() =>
      expect(world.bridge.crTools.startMonitor).toHaveBeenCalledTimes(1),
    )

    fireEvent.click(within(block).getByRole('button', { name: /Настроить в профиле/ }))
    expect(await screen.findByRole('dialog', { name: 'Профили' })).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(within(block).getByRole('button', { name: /Подключить/ }))
    expect(await screen.findByRole('heading', { name: 'Twitch-канал' })).toBeVisible()
  })

  it('widgets: only accounts are required, Twitch is explicitly not, and the fix opens settings', async () => {
    mountStream(
      { name: 'stream', section: 'widgets' },
      { readiness: { accountsCount: 0, twitchConnected: false } },
    )
    const needs = await screen.findByText('Нужно для работы')
    const block = parentOf(needs)
    expect(within(block).getByText('Аккаунты Clash Royale')).toBeVisible()
    expect(within(block).queryByText('Twitch')).not.toBeInTheDocument()
    expect(within(block).getByText(/Twitch виджетам не нужен/)).toBeVisible()
    fireEvent.click(within(block).getByRole('button', { name: /Добавить/ }))
    expect(
      await screen.findByRole('heading', { name: 'Аккаунты Clash Royale' }),
    ).toBeVisible()
  })

  it('unknown readiness is "could not check", never "not connected"', async () => {
    mountStream(
      { name: 'stream', section: 'chat' },
      { readiness: { twitchConnected: null } },
    )
    const needs = await screen.findByText('Нужно для работы')
    const block = parentOf(needs)
    expect(within(block).getAllByText('не удалось проверить').length).toBeGreaterThan(0)
    expect(within(block).queryByText('не подключён')).not.toBeInTheDocument()
  })
})

describe('predictions', () => {
  it('starts with the edited preferences and keeps them when starting fails', async () => {
    const world = mountStream({ name: 'stream', section: 'predictions' })
    world.fake.handlers.push((command) =>
      command.action === 'predictions.start'
        ? failure('PREDICTION_START_FAILED')
        : undefined,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Серия побед' }))
    fireEvent.click(screen.getByRole('button', { name: /Включить прогнозы/ }))
    expect(await screen.findByText(/Не удалось включить прогнозы/)).toBeVisible()
    const start = world.fake.command.mock.calls.find(
      ([command]) => command.action === 'predictions.start',
    )?.[0] as Extract<StreamerCommand, { action: 'predictions.start' }>
    expect(start.settings.predictionType).toBe('win_streak')
    // The draft stays in the form.
    expect(screen.getByRole('button', { name: 'Серия побед' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText(/Параметры сохранены в форме/)).toBeVisible()
  })

  it('locks the preferences while predictions run and stops them', async () => {
    const world = mountStream(
      { name: 'stream', section: 'predictions' },
      {
        view: (view) => {
          view.predictions.active = true
          view.predictions.runtimeState = 'active'
        },
      },
    )
    expect(await screen.findByText('Включены, идут сами')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Смешанный' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Выключить прогнозы/ }))
    await waitFor(() =>
      expect(world.fake.command).toHaveBeenCalledWith({ action: 'predictions.stop' }),
    )
    expect(await screen.findByRole('button', { name: /Включить прогнозы/ })).toBeVisible()
  })
})

describe('chat', () => {
  it('toggles deck sharing and blocks switching on while Twitch is missing', async () => {
    const world = mountStream({ name: 'stream', section: 'chat' })
    const toggle = await screen.findByRole('switch', { name: 'Отправлять колоды в чат' })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(world.fake.command).toHaveBeenCalledWith({
        action: 'chat.toggle',
        enabled: true,
      }),
    )
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  })

  it('cannot be switched on without Twitch and monitoring', async () => {
    mountStream(
      { name: 'stream', section: 'chat' },
      { readiness: { twitchConnected: false, monitoring: false } },
    )
    expect(
      await screen.findByRole('switch', { name: 'Отправлять колоды в чат' }),
    ).toBeDisabled()
    expect(screen.getByText('Сначала закройте пункты выше')).toBeVisible()
  })
})

describe('twitch', () => {
  it('connects through the command and shows the browser wait while polling', async () => {
    const world = mountStream(
      { name: 'stream', section: 'twitch' },
      {
        view: (view) => {
          view.twitch = { connected: false, username: null, polling: false }
        },
      },
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить Twitch' }))
    await waitFor(() =>
      expect(world.fake.command).toHaveBeenCalledWith({ action: 'twitch.connect' }),
    )
    expect(await screen.findByText('Ждём подтверждения в браузере')).toBeVisible()
  })

  it('disconnect needs confirmation, shows the real failure and closes only on success', async () => {
    const world = mountStream({ name: 'stream', section: 'twitch' })
    let attempts = 0
    world.fake.handlers.push((command) =>
      command.action === 'twitch.disconnect' && attempts++ === 0
        ? failure('NETWORK_UNAVAILABLE')
        : undefined,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Отключить' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Отключить Twitch?' })
    expect(world.fake.command).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'twitch.disconnect' }),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отключить Twitch' }))
    expect(await within(dialog).findByText(/Нет связи с сервером/)).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отключить Twitch' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(world.fake.command).toHaveBeenCalledWith({
      action: 'twitch.disconnect',
      confirmed: true,
    })
    expect(await screen.findByText('Twitch не подключён')).toBeVisible()
  })
})
