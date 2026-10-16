// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CaptureProfileSummary,
  CaptureProfilesView,
} from '../../../../shared/models/capture'
import { monitorViewFixture } from '../../../../tests/monitor-fixtures'
import { authFixture, profilesFixture } from '../../test/bridge'
import { mountSetup, stubStageGeometry, type SetupWorld } from '../../test/setupWorld'

type Patch = Partial<CaptureProfileSummary>

function profiles(
  count: number,
  patches: Record<number, Patch> = {},
): CaptureProfilesView {
  const base = profilesFixture(
    Array.from({ length: count }, (_, index) => `Профиль ${index + 1}`),
  )
  return {
    ...base,
    profiles: base.profiles.map((profile, index) => ({ ...profile, ...patches[index] })),
  }
}

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function mutation(view: CaptureProfilesView) {
  return {
    ok: true,
    profiles: view,
    monitor: monitorViewFixture({ state: 'READY', runIntent: true }),
    capture: { configured: true, revision: view.revision, sourceLabel: 'BlueStacks' },
  }
}

async function openPanel(world: SetupWorld): Promise<HTMLElement> {
  void world
  fireEvent.click(await screen.findByRole('button', { name: /^Профиль: / }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Управлять профилями/ }))
  return screen.findByRole('dialog', { name: 'Профили' })
}

const rowOf = (panel: HTMLElement, name: string): HTMLElement =>
  within(panel).getByRole('group', { name })

function openMenu(row: HTMLElement, name: string): void {
  fireEvent.click(
    within(row).getByRole('button', { name: `Действия с профилем «${name}»` }),
  )
}

beforeEach(() => {
  stubStageGeometry()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('profiles panel: health from main', () => {
  it('shows source and calibration health exactly as main reports it', async () => {
    const world = mountSetup(
      { name: 'main' },
      {
        profiles: profiles(5, {
          1: { sourceHealth: { state: 'missing', reason: null } },
          2: { sourceHealth: { state: 'ambiguous', reason: null } },
          3: {
            sourceHealth: {
              state: 'metadata_unavailable',
              reason: 'SOURCE_REBIND_REQUIRED',
            },
            calibrationHealth: 'needs_validation',
          },
          4: { calibrationHealth: 'imported' },
        }),
      },
    )
    const panel = await openPanel(world)
    expect(within(rowOf(panel, 'Профиль 1')).getByText('Активный')).toBeVisible()
    expect(within(rowOf(panel, 'Профиль 2')).getByText(/окно не найдено/)).toBeVisible()
    expect(within(rowOf(panel, 'Профиль 3')).getByText(/· несколько окон/)).toBeVisible()
    expect(
      within(rowOf(panel, 'Профиль 3')).getByText(
        'Подходит несколько окон — выберите нужное',
      ),
    ).toBeVisible()
    const rebind = rowOf(panel, 'Профиль 4')
    expect(within(rebind).getByText('Требуется перепривязка источника')).toBeVisible()
    expect(within(rebind).getByText('Области нужно проверить заново')).toBeVisible()
    expect(
      within(rowOf(panel, 'Профиль 5')).getByText('Области перенесены из прежней версии'),
    ).toBeVisible()
    // A validated profile has no calibration note.
    expect(
      within(rowOf(panel, 'Профиль 1')).queryByText(/Области/),
    ).not.toBeInTheDocument()
  })

  it('offers no result-zone setup, even to a streamer', async () => {
    const world = mountSetup(
      { name: 'main' },
      { auth: authFixture(['user', 'streamer']), profiles: profiles(2) },
    )
    const panel = await openPanel(world)
    expect(within(panel).queryByText(/Зоны результата/)).not.toBeInTheDocument()
    expect(
      within(rowOf(panel, 'Профиль 1')).queryByRole('button', { name: 'Настроить' }),
    ).not.toBeInTheDocument()
    openMenu(rowOf(panel, 'Профиль 1'), 'Профиль 1')
    expect(await screen.findByRole('menuitem', { name: /Перенастроить/ })).toBeVisible()
    expect(
      screen.queryByRole('menuitem', { name: /зоны результата/i }),
    ).not.toBeInTheDocument()
    expect(world.bridge.crTools.setup).not.toHaveProperty('startResult')
  })
})

describe('profiles panel: activate', () => {
  it('activates with the collection revision and forwards the monitor view', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    const next = profiles(2)
    world.bridge.crTools.activateCaptureProfile.mockResolvedValue(
      mutation({
        ...next,
        revision: 2,
        activeProfileId: uuid(2),
        profiles: next.profiles.map((profile) => ({
          ...profile,
          isActive: profile.profileId === uuid(2),
        })),
      }),
    )
    const panel = await openPanel(world)
    fireEvent.click(
      within(rowOf(panel, 'Профиль 2')).getByRole('button', { name: 'Сделать активным' }),
    )
    await waitFor(() =>
      expect(within(rowOf(panel, 'Профиль 2')).getByText('Активный')).toBeVisible(),
    )
    expect(world.bridge.crTools.activateCaptureProfile).toHaveBeenCalledWith({
      profileId: uuid(2),
      expectedRevision: 1,
    })
  })

  it('refreshes the list and explains a stale activation', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    world.bridge.crTools.activateCaptureProfile.mockResolvedValue({
      ok: false,
      error: { code: 'CAPTURE_PROFILE_STALE' },
    })
    const panel = await openPanel(world)
    const loads = world.bridge.crTools.getCaptureProfiles.mock.calls.length
    fireEvent.click(
      within(rowOf(panel, 'Профиль 2')).getByRole('button', { name: 'Сделать активным' }),
    )
    expect(
      await within(panel).findByText(
        'Список профилей изменился. Мы его обновили — повторите действие.',
      ),
    ).toBeVisible()
    await waitFor(() =>
      expect(world.bridge.crTools.getCaptureProfiles.mock.calls.length).toBeGreaterThan(
        loads,
      ),
    )
  })
})

describe('profiles panel: rename', () => {
  it('renames inline with the collection revision', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    const renamed = profiles(2)
    world.bridge.crTools.renameCaptureProfile.mockResolvedValue(
      mutation({
        ...renamed,
        revision: 2,
        profiles: renamed.profiles.map((profile) =>
          profile.profileId === uuid(2)
            ? { ...profile, profileName: 'Для друзей' }
            : profile,
        ),
      }),
    )
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 2'), 'Профиль 2')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Переименовать/ }))
    const input = within(panel).getByRole('textbox', { name: 'Название профиля' })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'Для друзей' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await within(panel).findByRole('group', { name: 'Для друзей' })).toBeVisible()
    expect(world.bridge.crTools.renameCaptureProfile).toHaveBeenCalledWith({
      profileId: uuid(2),
      profileName: 'Для друзей',
      expectedRevision: 1,
    })
  })

  it('rejects an existing name regardless of case without calling main, and Esc cancels', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 2'), 'Профиль 2')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Переименовать/ }))
    const input = within(panel).getByRole('textbox', { name: 'Название профиля' })
    fireEvent.change(input, { target: { value: 'профиль 1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(
      await within(panel).findByText(
        'Профиль с таким названием уже есть. Выберите другое.',
      ),
    ).toBeVisible()
    expect(world.bridge.crTools.renameCaptureProfile).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await within(panel).findByText('Введите название профиля.')).toBeVisible()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Профили' })).toBeVisible()
  })

  it('keeps the editor open with the reason when main refuses the name', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    world.bridge.crTools.renameCaptureProfile.mockResolvedValue({
      ok: false,
      error: { code: 'CAPTURE_PROFILE_NAME_CONFLICT' },
    })
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 2'), 'Профиль 2')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Переименовать/ }))
    const input = within(panel).getByRole('textbox', { name: 'Название профиля' })
    fireEvent.change(input, { target: { value: 'Новое' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Сохранить' }))
    expect(
      await within(panel).findByText(
        'Профиль с таким названием уже есть. Выберите другое.',
      ),
    ).toBeVisible()
    expect(within(panel).getByRole('textbox', { name: 'Название профиля' })).toHaveValue(
      'Новое',
    )
  })
})

describe('profiles panel: duplicate', () => {
  it('suggests a free copy name and offers to bind another window', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    const copied = profiles(3)
    world.bridge.crTools.duplicateCaptureProfile.mockResolvedValue(
      mutation({
        ...copied,
        revision: 2,
        profiles: copied.profiles.map((profile, index) =>
          index === 2 ? { ...profile, profileName: 'Профиль 1 — копия' } : profile,
        ),
      }),
    )
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 1'), 'Профиль 1')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Дублировать/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Дублировать «Профиль 1»' })
    const input = within(dialog).getByRole('textbox', { name: 'Название копии' })
    expect(input).toHaveValue('Профиль 1 — копия')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать копию' }))
    expect(await screen.findByText('Копия «Профиль 1 — копия» создана')).toBeVisible()
    expect(world.bridge.crTools.duplicateCaptureProfile).toHaveBeenCalledWith({
      profileId: uuid(1),
      profileName: 'Профиль 1 — копия',
      expectedRevision: 1,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать другое окно' }))
    expect(
      await screen.findByRole('heading', {
        name: 'Новый источник для «Профиль 1 — копия»',
      }),
    ).toBeVisible()
  })

  it('blocks a duplicate name before calling main and shows a server refusal', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 1'), 'Профиль 1')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Дублировать/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Дублировать «Профиль 1»' })
    const input = within(dialog).getByRole('textbox', { name: 'Название копии' })
    fireEvent.change(input, { target: { value: 'ПРОФИЛЬ 2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать копию' }))
    expect(
      await within(dialog).findByText(
        'Профиль с таким названием уже есть. Выберите другое.',
      ),
    ).toBeVisible()
    expect(world.bridge.crTools.duplicateCaptureProfile).not.toHaveBeenCalled()
    world.bridge.crTools.duplicateCaptureProfile.mockResolvedValue({
      ok: false,
      error: { code: 'CAPTURE_PROFILE_LIMIT' },
    })
    fireEvent.change(input, { target: { value: 'Свободное' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать копию' }))
    expect(
      await within(dialog).findByText(
        'Достигнут предел — 20 профилей. Удалите ненужный профиль.',
      ),
    ).toBeVisible()
  })
})

describe('profiles panel: delete', () => {
  it('asks first, then deletes with the collection revision', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    const after = profiles(1)
    world.bridge.crTools.deleteCaptureProfile.mockResolvedValue(mutation(after))
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 2'), 'Профиль 2')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Удалить/ }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Удалить профиль «Профиль 2»?',
    })
    expect(within(dialog).getByText(/Остальные профили не изменятся/)).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    expect(world.bridge.crTools.deleteCaptureProfile).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())

    openMenu(rowOf(panel, 'Профиль 2'), 'Профиль 2')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Удалить/ }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Удалить',
      }),
    )
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(world.bridge.crTools.deleteCaptureProfile).toHaveBeenCalledWith({
      profileId: uuid(2),
      expectedRevision: 1,
    })
    expect(
      within(panel).queryByRole('group', { name: 'Профиль 2' }),
    ).not.toBeInTheDocument()
  })

  it('warns that deleting the active profile stops monitoring', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 1'), 'Профиль 1')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Удалить/ }))
    expect(
      await screen.findByText(/Профиль активен: мониторинг остановится/),
    ).toBeVisible()
  })

  it('keeps the dialog open with the reason when the collection changed', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(2) })
    world.bridge.crTools.deleteCaptureProfile.mockResolvedValue({
      ok: false,
      error: { code: 'CAPTURE_PROFILE_STALE' },
    })
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 2'), 'Профиль 2')
    fireEvent.click(await screen.findByRole('menuitem', { name: /Удалить/ }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Удалить',
      }),
    )
    expect(
      await within(await screen.findByRole('alertdialog')).findByText(
        'Список профилей изменился. Мы его обновили — повторите действие.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('alertdialog')).toBeVisible()
  })

  it('does not offer to delete the only profile', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(1) })
    const panel = await openPanel(world)
    openMenu(rowOf(panel, 'Профиль 1'), 'Профиль 1')
    expect(await screen.findByRole('menuitem', { name: /Удалить/ })).toBeDisabled()
    expect(screen.getByText('Единственный профиль удалить нельзя')).toBeVisible()
  })
})

describe('profiles panel: limit of 20 and new profile', () => {
  it('disables "Новый профиль" at 20 profiles with the reason', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(20) })
    const panel = await openPanel(world)
    const create = within(panel).getByRole('button', { name: /Новый профиль/ })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('title', 'Достигнут предел — 20 профилей')
    expect(within(panel).getByText(/20 из 20/)).toBeVisible()
  })

  it('opens the setup route for a new profile and closes the panel', async () => {
    const world = mountSetup({ name: 'main' }, { profiles: profiles(19) })
    const panel = await openPanel(world)
    expect(within(panel).getByText(/19 из 20/)).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: /Новый профиль/ }))
    expect(
      await screen.findByRole('heading', { name: 'Как назовём профиль?' }),
    ).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Профили' })).not.toBeInTheDocument()
  })
})

describe('profiles panel: rebind and recalibrate', () => {
  it('opens a source-only setup to rebind and the full one to recalibrate', async () => {
    const world = mountSetup(
      { name: 'main' },
      {
        profiles: profiles(2, {
          0: {
            sourceHealth: {
              state: 'metadata_unavailable',
              reason: 'SOURCE_REBIND_REQUIRED',
            },
            calibrationHealth: 'needs_validation',
          },
        }),
      },
    )
    let panel = await openPanel(world)
    fireEvent.click(
      within(rowOf(panel, 'Профиль 1')).getByRole('button', { name: 'Выбрать окно' }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Новый источник для «Профиль 1»' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    // Back on the previous destination, the panel can be reopened.
    panel = await openPanel(world)
    fireEvent.click(
      within(rowOf(panel, 'Профиль 1')).getByRole('button', { name: 'Перенастроить' }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Перенастройка «Профиль 1»' }),
    ).toBeVisible()
  })
})
