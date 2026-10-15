// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  StreamerCommand,
  StreamerCommandResult,
} from '../../../../shared/contracts/streamer-ipc'
import type { StreamerView } from '../../../../shared/models/streamer'
import {
  failure,
  mountStream,
  ok,
  predictionFixture,
  type StreamWorld,
} from '../../test/streamerWorld'
import { PREDICTION_PHRASES } from './text'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Predictions = StreamerView['predictions']

const PREDICTIONS = { name: 'stream', section: 'predictions' } as const

/** The page with the server status patched (a copy: the fake mutates its view). */
function mountPredictions(patch: Partial<Predictions> = {}): StreamWorld {
  return mountStream(PREDICTIONS, {
    view: (view) => Object.assign(view.predictions, structuredClone(patch)),
  })
}

/** A live, ready channel with the default prediction in `phase`. */
function running(patch: Partial<Predictions> = {}): Partial<Predictions> {
  return {
    live: true,
    clientReady: true,
    phase: 'voting',
    prediction: predictionFixture(),
    ...patch,
  }
}

const STREAK = predictionFixture({
  title: 'Выиграю 5 боёв подряд?',
  mode: 'streak',
  target: 5,
  wins: 3,
})

const commandsOf = (
  world: StreamWorld,
  action: StreamerCommand['action'],
): StreamerCommand[] =>
  world.fake.command.mock.calls
    .map(([command]) => command)
    .filter((command) => command.action === action)

const CANCEL = 'Отменить и вернуть ставки'
const button = (name: string | RegExp): HTMLElement =>
  screen.getByRole('button', { name })
const pressed = (name: string): string | null => button(name).getAttribute('aria-pressed')
const stepper = (name: string): HTMLElement => screen.getByRole('group', { name })
const stepButton = (group: string, name: 'Уменьшить' | 'Увеличить'): HTMLElement =>
  within(stepper(group)).getByRole('button', { name })
const stepperValue = (name: string): string | null =>
  within(stepper(name)).getByRole('spinbutton').getAttribute('aria-valuenow')

/** Codes and server words that must never reach the screen. */
const TECHNICAL =
  /result_unknown|result_missed|settle_after_disable|stream_ended|client_lost|twitch_unavailable|channel_not_eligible|waiting_stream|client_not_ready|resolved_|each_battle|new_code/

describe('predictions: status pill uses only the fixed phrases', () => {
  const ALL = Object.values(PREDICTION_PHRASES)

  it.each<[string, Partial<Predictions>, string]>([
    ['voting', running(), PREDICTION_PHRASES.voting],
    ['locked, each battle', running({ phase: 'locked' }), PREDICTION_PHRASES.locked],
    ['locked streak', running({ phase: 'locked', prediction: STREAK }), 'Серия: 3 из 5'],
    [
      'result unknown',
      running({ phase: 'locked', attention: 'result_unknown' }),
      PREDICTION_PHRASES.unknown,
    ],
    [
      'result missed',
      running({ phase: 'locked', attention: 'result_missed' }),
      PREDICTION_PHRASES.unknown,
    ],
    [
      'disabled with bets',
      running({ enabled: false, attention: 'settle_after_disable' }),
      PREDICTION_PHRASES.settle,
    ],
    [
      'stream ended with bets',
      running({ live: false, phase: 'locked', attention: 'stream_ended' }),
      PREDICTION_PHRASES.settle,
    ],
    [
      'stream ended without bets',
      running({
        live: false,
        phase: 'locked',
        attention: 'stream_ended',
        prediction: predictionFixture({ hasBets: false }),
      }),
      PREDICTION_PHRASES.unknown,
    ],
    [
      'app closed during the prediction',
      running({ clientReady: false, phase: 'locked', attention: 'client_lost' }),
      PREDICTION_PHRASES.settle,
    ],
    [
      'Twitch fails during the prediction',
      running({ attention: 'twitch_unavailable' }),
      PREDICTION_PHRASES.twitch,
    ],
    [
      'Twitch fails before a prediction',
      { live: true, phase: 'idle', attention: 'twitch_unavailable' },
      PREDICTION_PHRASES.twitch,
    ],
    [
      'channel cannot run predictions',
      { live: true, phase: 'idle', attention: 'channel_not_eligible' },
      PREDICTION_PHRASES.notEligible,
    ],
    [
      'waiting for the stream',
      { phase: 'waiting_stream' },
      PREDICTION_PHRASES.waitingStream,
    ],
    [
      'stream offline during the prediction',
      running({ live: false, phase: 'locked' }),
      PREDICTION_PHRASES.waitingStream,
    ],
    [
      'monitoring not ready',
      { live: true, clientReady: false, phase: 'client_not_ready' },
      PREDICTION_PHRASES.openMonitor,
    ],
    [
      'monitoring closed during the prediction',
      running({ clientReady: false }),
      PREDICTION_PHRASES.openMonitor,
    ],
    ['switched off', { enabled: false, phase: 'disabled' }, PREDICTION_PHRASES.disabled],
    [
      'an attention code this version does not know',
      running({ attention: 'new_code' }),
      PREDICTION_PHRASES.voting,
    ],
  ])('%s', async (_, patch, phrase) => {
    mountPredictions(patch)
    expect((await screen.findAllByText(phrase)).length).toBeGreaterThan(0)
    for (const other of ALL)
      if (other !== phrase) expect(screen.queryByText(other)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(TECHNICAL)
  })

  it('says nothing while the next prediction is about to open', async () => {
    mountPredictions({ live: true, phase: 'idle' })
    expect(await screen.findByText('Прогноза сейчас нет')).toBeVisible()
    for (const phrase of ALL) expect(screen.queryByText(phrase)).not.toBeInTheDocument()
  })

  it('shows the title and «Серия: k из N» of a streak while voting', async () => {
    mountPredictions(running({ prediction: { ...STREAK, wins: 1 } }))
    expect(await screen.findByText(PREDICTION_PHRASES.voting)).toBeVisible()
    expect(screen.getByText('Серия: 1 из 5')).toBeVisible()
    expect(screen.getByText(/«Выиграю 5 боёв подряд\?»/)).toBeVisible()
  })

  it('counts predictions as resolved plus canceled', async () => {
    mountPredictions()
    const label = await screen.findByText('Прогнозов')
    expect(label.parentElement).toHaveTextContent('14')
    expect(screen.getByText('Да').parentElement).toHaveTextContent('7')
    expect(screen.getByText('Нет').parentElement).toHaveTextContent('5')
    expect(screen.getByText('Отменены').parentElement).toHaveTextContent('2')
    expect(screen.queryByText(/Успешных|Доля успешных/)).not.toBeInTheDocument()
  })
})

describe('predictions: manual settle', () => {
  const STATES: [string, Partial<Predictions>][] = [
    ['voting', running()],
    ['locked', running({ phase: 'locked' })],
    ['result unknown', running({ phase: 'locked', attention: 'result_unknown' })],
    ['result missed', running({ phase: 'locked', attention: 'result_missed' })],
    [
      'disabled with bets',
      running({ enabled: false, phase: 'locked', attention: 'settle_after_disable' }),
    ],
    [
      'stream ended',
      running({ live: false, phase: 'locked', attention: 'stream_ended' }),
    ],
    [
      'app closed',
      running({ clientReady: false, phase: 'locked', attention: 'client_lost' }),
    ],
    ['Twitch not answering', running({ attention: 'twitch_unavailable' })],
    ['channel not eligible', running({ attention: 'channel_not_eligible' })],
  ]

  it.each(STATES)('%s: «Победа» resolves it', async (_, patch) => {
    const world = mountPredictions(patch)
    fireEvent.click(await screen.findByRole('button', { name: 'Победа' }))
    await waitFor(() =>
      expect(commandsOf(world, 'predictions.battle')).toEqual([
        { action: 'predictions.battle', predictionId: 41, outcome: 'win' },
      ]),
    )
    expect(await screen.findByText('Прогноза сейчас нет')).toBeVisible()
    expect(screen.getByText('Да').parentElement).toHaveTextContent('8')
  })

  it.each(STATES)('%s: «Поражение» resolves it', async (_, patch) => {
    const world = mountPredictions(patch)
    fireEvent.click(await screen.findByRole('button', { name: 'Поражение' }))
    await waitFor(() =>
      expect(commandsOf(world, 'predictions.battle')).toEqual([
        { action: 'predictions.battle', predictionId: 41, outcome: 'loss' },
      ]),
    )
    expect(await screen.findByText('Прогноза сейчас нет')).toBeVisible()
    expect(screen.getByText('Нет').parentElement).toHaveTextContent('6')
  })

  it.each(STATES)('%s: cancel refunds after one confirmation', async (_, patch) => {
    const world = mountPredictions(patch)
    fireEvent.click(await screen.findByRole('button', { name: CANCEL }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Отменить прогноз?' })
    expect(commandsOf(world, 'predictions.cancel')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Вернуть ставки' }))
    await waitFor(() =>
      expect(commandsOf(world, 'predictions.cancel')).toEqual([
        { action: 'predictions.cancel', predictionId: 41, confirmed: true },
      ]),
    )
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(await screen.findByText('Прогноза сейчас нет')).toBeVisible()
    expect(screen.getByText('Отменены').parentElement).toHaveTextContent('3')
  })

  it('offers no draw button', async () => {
    mountPredictions(running())
    await screen.findByRole('button', { name: 'Победа' })
    expect(screen.queryByRole('button', { name: /Ничья/ })).not.toBeInTheDocument()
  })

  it('shows no settle buttons without a prediction', async () => {
    mountPredictions({ phase: 'waiting_stream' })
    expect(await screen.findByText('Прогноза сейчас нет')).toBeVisible()
    for (const name of ['Победа', 'Поражение', 'Отменить и вернуть ставки'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  })

  it('counts one streak battle per «Победа» and ends the streak on «Поражение»', async () => {
    const world = mountPredictions(running({ phase: 'locked', prediction: STREAK }))
    expect((await screen.findAllByText('Серия: 3 из 5')).length).toBeGreaterThan(0)
    fireEvent.click(button('Победа'))
    expect((await screen.findAllByText('Серия: 4 из 5')).length).toBeGreaterThan(0)
    await waitFor(() => expect(button('Поражение')).toBeEnabled())
    fireEvent.click(button('Поражение'))
    expect(await screen.findByText('Прогноза сейчас нет')).toBeVisible()
    expect(commandsOf(world, 'predictions.battle')).toEqual([
      { action: 'predictions.battle', predictionId: 41, outcome: 'win' },
      { action: 'predictions.battle', predictionId: 41, outcome: 'loss' },
    ])
  })

  it('closing the confirmation sends nothing', async () => {
    const world = mountPredictions(running())
    fireEvent.click(await screen.findByRole('button', { name: CANCEL }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Отменить прогноз?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(commandsOf(world, 'predictions.cancel')).toHaveLength(0)
    expect(button('Победа')).toBeVisible()
  })

  it('cancels only the prediction the dialog was opened for, never a newer one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const world = mountPredictions(running())
    fireEvent.click(await screen.findByRole('button', { name: CANCEL }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Отменить прогноз?' })
    // Meanwhile the server settled #41 and opened #42; the next poll brings it.
    world.fake.view.predictions.prediction = predictionFixture({
      id: 42,
      title: 'Выиграю 2 боя подряд?',
      mode: 'streak',
      target: 2,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(await screen.findByText(/«Выиграю 2 боя подряд\?»/)).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Вернуть ставки' }))
    await waitFor(() =>
      expect(commandsOf(world, 'predictions.cancel')).toEqual([
        { action: 'predictions.cancel', predictionId: 41, confirmed: true },
      ]),
    )
    expect(await within(dialog).findByText(/Прогноз уже сменился/)).toBeVisible()
    expect(world.fake.view.predictions.prediction.id).toBe(42)
    expect(world.fake.view.predictions.stats.canceled).toBe(2)
  })

  it('passes the shown prediction to «Победа» and explains a stale one', async () => {
    const world = mountPredictions(running())
    world.fake.handlers.push((command) =>
      command.action === 'predictions.battle' ? failure('VALIDATION_FAILED') : undefined,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Победа' }))
    expect(await screen.findByText(/Прогноз уже сменился/)).toBeVisible()
    expect(commandsOf(world, 'predictions.battle')[0]).toMatchObject({ predictionId: 41 })
    expect(button('Победа')).toBeEnabled()
  })
})

describe('predictions: one command at a time', () => {
  it('disables every prediction control while a command runs', async () => {
    const world = mountPredictions(running())
    const gate = Promise.withResolvers<StreamerCommandResult>()
    world.fake.handlers.push((command) =>
      command.action === 'predictions.battle' ? gate.promise : undefined,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Серия побед' }))
    fireEvent.click(button('Победа'))
    await waitFor(() => expect(button('Поражение')).toBeDisabled())
    for (const name of ['Победа', 'Отменить и вернуть ставки', 'Сохранить', 'Каждый бой'])
      expect(button(name)).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Автопрогнозы' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Время на ставки' })).toBeDisabled()
    expect(stepButton('Побед подряд', 'Уменьшить')).toBeDisabled()
    expect(stepButton('Побед подряд', 'Увеличить')).toBeDisabled()
    fireEvent.click(button('Поражение'))
    expect(commandsOf(world, 'predictions.battle')).toHaveLength(1)

    await act(async () => {
      world.fake.view.predictions.prediction = null
      gate.resolve(ok(structuredClone(world.fake.view)))
      await gate.promise
    })
    await waitFor(() => expect(button('Сохранить')).toBeEnabled())
    // The unsaved draft survived the command.
    expect(pressed('Серия побед')).toBe('true')
  })

  it('a settings save blocks the manual buttons until it finishes', async () => {
    const world = mountPredictions(running())
    const gate = Promise.withResolvers<StreamerCommandResult>()
    world.fake.handlers.push((command) =>
      command.action === 'predictions.settings.save' ? gate.promise : undefined,
    )
    fireEvent.change(await screen.findByRole('combobox', { name: 'Время на ставки' }), {
      target: { value: '60' },
    })
    fireEvent.click(button('Сохранить'))
    await waitFor(() => expect(button('Победа')).toBeDisabled())
    expect(button('Поражение')).toBeDisabled()
    expect(button('Отменить и вернуть ставки')).toBeDisabled()
    await act(async () => {
      gate.resolve(ok(structuredClone(world.fake.view)))
      await gate.promise
    })
    await waitFor(() => expect(button('Победа')).toBeEnabled())
  })
})

describe('predictions: settings (§3.8)', () => {
  it('shows the defaults: on, each battle, 30 s', async () => {
    mountPredictions()
    expect(await screen.findByRole('switch', { name: 'Автопрогнозы' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(pressed('Каждый бой')).toBe('true')
    expect(pressed('Серия побед')).toBe('false')
    const select = screen.getByRole('combobox', { name: 'Время на ставки' })
    expect(select).toHaveValue('30')
    const options = within(select).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      '30 с',
      '45 с',
      '1 мин',
      '1,5 мин',
      '2 мин',
      '3 мин',
    ])
    // Streak-only settings stay hidden for «Каждый бой».
    expect(screen.queryByRole('group', { name: 'Длина серии' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: 'Писать прогресс в чат' }),
    ).not.toBeInTheDocument()
    expect(button('Сохранить')).toBeDisabled()
    for (const removed of [/Пауза между прогнозами/, /Смешанный/, /Открывать следующий/])
      expect(screen.queryByText(removed)).not.toBeInTheDocument()
  })

  it('saves a fixed streak: «Точно», 2–10 wins, default 3, chat progress on', async () => {
    const world = mountPredictions()
    fireEvent.click(await screen.findByRole('button', { name: 'Серия побед' }))
    expect(pressed('Точно')).toBe('true')
    expect(stepperValue('Побед подряд')).toBe('3')
    const fewer = stepButton('Побед подряд', 'Уменьшить')
    fireEvent.click(fewer)
    expect(stepperValue('Побед подряд')).toBe('2')
    expect(fewer).toBeDisabled()
    const more = stepButton('Побед подряд', 'Увеличить')
    for (let step = 0; step < 10; step += 1) fireEvent.click(more)
    expect(stepperValue('Побед подряд')).toBe('10')
    expect(more).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Писать прогресс в чат' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Время на ставки' }), {
      target: { value: '90' },
    })
    fireEvent.click(button('Сохранить'))
    await waitFor(() =>
      expect(commandsOf(world, 'predictions.settings.save')).toEqual([
        {
          action: 'predictions.settings.save',
          settings: {
            enabled: true,
            mode: 'streak',
            streakKind: 'fixed',
            streakLength: 10,
            streakFrom: 2,
            streakTo: 5,
            votingSeconds: 90,
            chatProgress: true,
          },
        },
      ]),
    )
    await waitFor(() => expect(button('Сохранить')).toBeDisabled())
    expect(pressed('Серия побед')).toBe('true')
  })

  it('keeps a random range «От» ≤ «До» within 1–10, default 2–5', async () => {
    const world = mountPredictions()
    fireEvent.click(await screen.findByRole('button', { name: 'Серия побед' }))
    fireEvent.click(button('Случайно'))
    expect(stepperValue('От')).toBe('2')
    expect(stepperValue('До')).toBe('5')
    const fromUp = stepButton('От', 'Увеличить')
    for (let step = 0; step < 5; step += 1) fireEvent.click(fromUp)
    // «От» stops at «До».
    expect(stepperValue('От')).toBe('5')
    expect(fromUp).toBeDisabled()
    const toDown = stepButton('До', 'Уменьшить')
    expect(toDown).toBeDisabled()
    const toUp = stepButton('До', 'Увеличить')
    for (let step = 0; step < 10; step += 1) fireEvent.click(toUp)
    expect(stepperValue('До')).toBe('10')
    expect(toUp).toBeDisabled()
    const fromDown = stepButton('От', 'Уменьшить')
    for (let step = 0; step < 10; step += 1) fireEvent.click(fromDown)
    expect(stepperValue('От')).toBe('1')
    expect(fromDown).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Писать прогресс в чат' }))
    fireEvent.click(button('Сохранить'))
    await waitFor(() =>
      expect(commandsOf(world, 'predictions.settings.save')).toEqual([
        {
          action: 'predictions.settings.save',
          settings: {
            enabled: true,
            mode: 'streak',
            streakKind: 'random',
            streakLength: 3,
            streakFrom: 1,
            streakTo: 10,
            votingSeconds: 30,
            chatProgress: false,
          },
        },
      ]),
    )
  })

  it('keeps the edits in the form when saving fails', async () => {
    const world = mountPredictions()
    world.fake.handlers.push((command) =>
      command.action === 'predictions.settings.save'
        ? failure('NETWORK_UNAVAILABLE')
        : undefined,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Серия побед' }))
    fireEvent.click(button('Сохранить'))
    expect(await screen.findByText(/Изменения остались в форме/)).toBeVisible()
    expect(pressed('Серия побед')).toBe('true')
    expect(button('Сохранить')).toBeEnabled()
    world.fake.handlers.length = 0
    fireEvent.click(button('Сохранить'))
    await waitFor(() => expect(world.fake.view.predictions.settings.mode).toBe('streak'))
    await waitFor(() =>
      expect(screen.queryByText(/Изменения остались в форме/)).not.toBeInTheDocument(),
    )
  })

  it('stays editable while a prediction runs; changes apply to the next one', async () => {
    mountPredictions(running())
    expect(await screen.findByText('изменения — со следующего прогноза')).toBeVisible()
    expect(button('Серия побед')).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Время на ставки' })).toBeEnabled()
    expect(screen.getByRole('switch', { name: 'Автопрогнозы' })).toBeEnabled()
  })

  it('«Автопрогнозы» saves at once with the saved settings and keeps the draft', async () => {
    const world = mountPredictions()
    fireEvent.click(await screen.findByRole('button', { name: 'Серия побед' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Автопрогнозы' }))
    await waitFor(() =>
      expect(commandsOf(world, 'predictions.settings.save')).toEqual([
        {
          action: 'predictions.settings.save',
          settings: {
            enabled: false,
            mode: 'each_battle',
            streakKind: 'fixed',
            streakLength: 3,
            streakFrom: 2,
            streakTo: 5,
            votingSeconds: 30,
            chatProgress: true,
          },
        },
      ]),
    )
    expect(await screen.findByText(PREDICTION_PHRASES.disabled)).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Автопрогнозы' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(pressed('Серия побед')).toBe('true')
    expect(button('Сохранить')).toBeEnabled()
  })
})
