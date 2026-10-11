// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StreamerCommand } from '../../../../shared/contracts/streamer-ipc'
import { failure, mountStream, ok, type StreamWorld } from '../../test/streamerWorld'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const TITLE = { name: 'stream', section: 'title' } as const

type Saved = Extract<
  StreamerCommand,
  { action: 'title.save' | 'title.preview' | 'title.apply' }
>

const commandsOf = (world: StreamWorld, action: string): StreamerCommand[] =>
  world.fake.command.mock.calls
    .map(([command]) => command)
    .filter((c) => c.action === action)

async function selectedPreset(name: RegExp): Promise<HTMLElement> {
  const tile = await screen.findByRole('button', { name })
  await waitFor(() => expect(tile).toHaveAttribute('aria-pressed', 'true'))
  return tile
}

describe('title: presets round trip through compile and decompile', () => {
  it('decompiles the saved template, previews the real server answer and saves the compiled settings', async () => {
    const world = mountStream(TITLE)
    await selectedPreset(/^Полный/)
    // Not edited: the preview is the server's own saved title.
    expect(screen.getByTestId('title-preview')).toHaveTextContent(
      '★ 297 · 2 675 ELO · 5W-2L · +12',
    )
    expect(screen.queryByRole('region', { name: 'Несохранённые изменения' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Коротко/ }))
    const bar = await screen.findByRole('region', { name: 'Несохранённые изменения' })
    await waitFor(() =>
      expect(screen.getByTestId('title-preview')).toHaveTextContent(
        'PREVIEW {rank} · {elo}',
      ),
    )
    const compile = world.api.compileTitle
    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({ builder: { mode: 'preset', preset: 'short' } }),
    )
    // The preview request carries the compiled settings, nothing is sent to Twitch yet.
    const preview = commandsOf(world, 'title.preview').at(-1) as Saved
    expect(preview.settings.prefixTemplate).toBe('{rank} · {elo}')
    expect(commandsOf(world, 'title.apply')).toHaveLength(0)

    fireEvent.click(within(bar).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(commandsOf(world, 'title.save')).toHaveLength(1))
    const saved = commandsOf(world, 'title.save')[0] as Saved
    expect(saved.settings).toMatchObject({
      prefixTemplate: '{rank} · {elo}',
      includeRank: true,
      includeElo: true,
      includeWl: false,
      includeDelta: false,
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Несохранённые изменения' }),
      ).toBeNull(),
    )
    await selectedPreset(/^Коротко/)
  })

  it('keeps the edited draft and shows the error when saving fails', async () => {
    const world = mountStream(TITLE)
    world.fake.handlers.push((command) =>
      command.action === 'title.save' ? failure('SERVER_ERROR') : undefined,
    )
    await selectedPreset(/^Полный/)
    fireEvent.click(screen.getByRole('button', { name: /^Со счётом/ }))
    const bar = await screen.findByRole('region', { name: 'Несохранённые изменения' })
    fireEvent.click(within(bar).getByRole('button', { name: 'Сохранить' }))
    expect(await within(bar).findByText(/На сервере что-то пошло не так/)).toBeVisible()
    expect(screen.getByRole('button', { name: /^Со счётом/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(within(bar).getByRole('button', { name: 'Отменить изменения' }))
    await selectedPreset(/^Полный/)
  })
})

describe('title: chip builder', () => {
  it('compiles chips, including free text, and refuses nothing silently', async () => {
    const world = mountStream(TITLE)
    await selectedPreset(/^Полный/)
    fireEvent.click(screen.getByRole('button', { name: /Свой вариант/ }))
    expect(await screen.findByText('Изменение рейтинга')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Изменение рейтинга»' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Убрать «Изменение рейтинга»' }),
      ).toBeNull(),
    )

    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Свой текст/ }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Свой текст' }), {
      target: { value: 'Играю' },
    })
    const compile = world.api.compileTitle
    await waitFor(() =>
      expect(compile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          builder: {
            mode: 'chips',
            chips: [
              { kind: 'rank' },
              { kind: 'elo' },
              { kind: 'wl' },
              { kind: 'text', text: 'Играю' },
            ],
          },
        }),
      ),
    )
    // The typed text is visible at once (the field never loses characters).
    expect(screen.getByRole('textbox', { name: 'Свой текст' })).toHaveValue('Играю')
    await waitFor(() =>
      expect(screen.getByTestId('title-preview')).toHaveTextContent(
        'PREVIEW {rank} · {elo} · {wins}W-{losses}L | Играю',
      ),
    )
  })

  it('does not offer "Ник аккаунта" and "Лучший аккаунт" together', async () => {
    mountStream(TITLE)
    await selectedPreset(/^Полный/)
    fireEvent.click(screen.getByRole('button', { name: /Свой вариант/ }))
    await screen.findByText('Изменение рейтинга')
    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Ник аккаунта/ }))
    await screen.findByRole('button', { name: 'Убрать «Ник аккаунта»' })
    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }))
    await screen.findByRole('menuitem', { name: /Свой текст/ })
    expect(screen.queryByRole('menuitem', { name: /Лучший аккаунт/ })).toBeNull()
  })
})

describe('title: arbitrary existing templates stay lossless', () => {
  it('shows an unrecognised template as a special template and does not touch it', async () => {
    const world = mountStream(TITLE, {
      view: (view) => {
        view.title.settings.prefixTemplate = '{rank} !! особый {elo}'
        view.title.previewTitle = '★ 297 !! особый 2 675'
      },
    })
    expect(await screen.findByText('Особый шаблон')).toBeVisible()
    expect(screen.getByText('{rank} !! особый {elo}')).toBeVisible()
    expect(screen.getByTestId('title-preview')).toHaveTextContent('★ 297 !! особый 2 675')
    expect(screen.queryByRole('region', { name: 'Несохранённые изменения' })).toBeNull()
    const decompile = world.api.decompileTitle
    expect(decompile).toHaveBeenCalled()

    // Editing the template by hand goes through the raw builder.
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Шаблон названия' }), {
      target: { value: '{elo} ?? моё' },
    })
    const compile = world.api.compileTitle
    await waitFor(() =>
      expect(compile).toHaveBeenLastCalledWith(
        expect.objectContaining({ builder: { mode: 'raw', template: '{elo} ?? моё' } }),
      ),
    )
    await screen.findByRole('region', { name: 'Несохранённые изменения' })
  })
})

describe('title: honest application wording', () => {
  it('says "Отправлено, Twitch не подтвердил" and never "Название обновлено"', async () => {
    const world = mountStream(TITLE)
    await selectedPreset(/^Полный/)
    fireEvent.click(screen.getByRole('button', { name: /Применить сейчас/ }))
    await waitFor(() => expect(commandsOf(world, 'title.apply')).toHaveLength(1))
    expect(
      (await screen.findAllByText('Отправлено, Twitch не подтвердил')).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText(/Название обновлено/)).toBeNull()
  })

  it('TITLE_UPDATE_FAILED means saved, but Twitch did not take it', async () => {
    const world = mountStream(TITLE)
    world.fake.handlers.push((command) =>
      command.action === 'title.apply'
        ? ok(structuredClone(world.fake.view), {
            titleApplication: 'failed',
            warnings: ['TITLE_UPDATE_FAILED'],
          })
        : undefined,
    )
    await selectedPreset(/^Полный/)
    fireEvent.click(screen.getByRole('button', { name: /Применить сейчас/ }))
    expect(
      (await screen.findAllByText(/Сохранено, но Twitch не принял название/)).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText('Отправлено, Twitch не подтвердил')).toBeNull()
  })

  it('the auto-update switch reports an unconfirmed application too', async () => {
    const world = mountStream(TITLE)
    world.fake.handlers.push((command) =>
      command.action === 'title.enabled'
        ? ok(structuredClone(world.fake.view), {
            titleApplication: 'unconfirmed',
            warnings: ['TITLE_APPLICATION_UNCONFIRMED'],
          })
        : undefined,
    )
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Обновлять название само' }),
    )
    expect(
      (await screen.findAllByText('Отправлено, Twitch не подтвердил')).length,
    ).toBeGreaterThan(0)
  })
})

describe('title: undo, reset and restore ask first', () => {
  it.each([
    ['Отменить последний', 'Отменить последний бой?', 'Отменить бой', 'title.undo'],
    ['Сбросить счёт…', 'Сбросить счёт?', 'Сбросить счёт', 'title.reset'],
    [
      'Вернуть прежнее название…',
      'Вернуть прежнее название?',
      'Вернуть название',
      'title.restore',
    ],
  ])(
    '%s: nothing is sent before the confirmation',
    async (button, title, confirm, action) => {
      const world = mountStream(TITLE)
      fireEvent.click(await screen.findByRole('button', { name: button }))
      const dialog = await screen.findByRole('alertdialog', { name: title })
      expect(commandsOf(world, action)).toHaveLength(0)
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(commandsOf(world, action)).toHaveLength(0)

      fireEvent.click(screen.getByRole('button', { name: button }))
      fireEvent.click(
        within(await screen.findByRole('alertdialog', { name: title })).getByRole(
          'button',
          {
            name: confirm,
          },
        ),
      )
      await waitFor(() => expect(commandsOf(world, action)).toHaveLength(1))
      expect(commandsOf(world, action)[0]).toEqual({ action, confirmed: true })
    },
  )
})
