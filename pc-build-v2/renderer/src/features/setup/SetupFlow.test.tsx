// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { monitorViewFixture } from '../../../../tests/monitor-fixtures'
import { profilesFixture } from '../../test/bridge'
import {
  EVIDENCE,
  NICK,
  PROFILE_ID,
  TRIGGER,
  resultView,
  sessionView,
  sourcesFixture,
  triggerProfile,
} from '../../test/setupFake'
import { mountSetup, stubStageGeometry, type SetupWorld } from '../../test/setupWorld'

const STAGE = 'Выделение области на рабочем кадре'
const px = (rect: { x: number; y: number; width: number; height: number }) => ({
  from: [rect.x * 800, rect.y * 400] as const,
  to: [(rect.x + rect.width) * 800, (rect.y + rect.height) * 400] as const,
})

function stage(): HTMLElement {
  return screen.getByRole('group', { name: STAGE })
}

function drag(
  from: readonly [number, number],
  to: readonly [number, number],
  options: { release?: boolean } = {},
): void {
  const target = stage()
  fireEvent.pointerDown(target, { clientX: from[0], clientY: from[1], pointerId: 1 })
  fireEvent.pointerMove(target, { clientX: to[0], clientY: to[1], pointerId: 1 })
  if (options.release !== false)
    fireEvent.pointerUp(target, { clientX: to[0], clientY: to[1], pointerId: 1 })
}

function draw(rect: { x: number; y: number; width: number; height: number }): void {
  const { from, to } = px(rect)
  drag(from, to)
}

const tab = (name: RegExp): HTMLElement => screen.getByRole('button', { name })

function setRegionCalls(
  world: SetupWorld,
): { region: string; rect: Record<string, number> }[] {
  return world.bridge.crTools.setup.setRegion.mock.calls.map(
    (call) => call[0] as unknown as { region: string; rect: Record<string, number> },
  )
}

async function findEditor(): Promise<void> {
  await screen.findByRole('heading', { name: 'Отметьте области вручную' })
  const editor = await screen.findByRole('group', { name: STAGE })
  await within(editor).findByRole('img')
}

beforeEach(() => {
  stubStageGeometry()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('setup flow: new profile', () => {
  it('walks name, source, frozen frame, three regions, analyzer check and save', async () => {
    const world = mountSetup(
      { name: 'setup' },
      { profiles: profilesFixture(['Основной']) },
    )
    const { crTools } = world.bridge

    // 1. name: unique without regard to case.
    const name = await screen.findByRole('textbox', { name: 'Название профиля' })
    expect(name).toHaveValue('Профиль 2')
    fireEvent.change(name, { target: { value: 'основной' } })
    expect(
      screen.getByText('Профиль с таким названием уже есть. Выберите другое.'),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: /Дальше/ })).toBeDisabled()
    fireEvent.change(name, { target: { value: 'Ноутбук' } })
    fireEvent.click(screen.getByRole('button', { name: /Дальше/ }))

    // 2. real sources; an unavailable one cannot be picked.
    await screen.findByRole('heading', { name: 'Откуда берём картинку?' })
    expect(await screen.findByRole('button', { name: /Диспетчер задач/ })).toBeDisabled()
    const freeze = screen.getByRole('button', { name: /Заморозить кадр/ })
    expect(freeze).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() => expect(freeze).toBeEnabled())
    expect(crTools.prepareCaptureSource).toHaveBeenCalledWith({
      sourceKey: 'a'.repeat(32),
      revision: 'c'.repeat(32),
    })

    // 3. freeze: the profile is new, bound to the collection revision.
    fireEvent.click(freeze)
    await findEditor()
    expect(crTools.startCaptureSetup).toHaveBeenCalledWith({
      preparationId: '00000000-0000-4000-8000-0000000000b1',
      profileId: null,
      profileName: 'Ноутбук',
      expectedRevision: 1,
    })
    expect(
      screen.getByRole('button', { name: /Дальше: проверка триггера/ }),
    ).toBeDisabled()

    // 4. three manual regions, saved as the user moves on.
    draw(TRIGGER)
    fireEvent.click(tab(/^Ник соперника/))
    await waitFor(() => expect(setRegionCalls(world)).toHaveLength(1))
    expect(setRegionCalls(world)[0]?.region).toBe('trigger')
    expect(setRegionCalls(world)[0]?.rect['x']).toBeCloseTo(0.1)
    draw(NICK)
    fireEvent.click(tab(/^Левая верхняя область/))
    await waitFor(() => expect(setRegionCalls(world)).toHaveLength(2))
    expect(setRegionCalls(world)[1]?.region).toBe('nickname')
    draw(EVIDENCE)
    expect(
      screen.getByRole('button', { name: /Дальше: проверка триггера/ }),
    ).toBeEnabled()

    // 5. the real analyzer, then review and commit.
    fireEvent.click(screen.getByRole('button', { name: /Дальше: проверка триггера/ }))
    expect(await screen.findByRole('heading', { name: 'Триггер проверен' })).toBeVisible()
    expect(setRegionCalls(world).map((call) => call.region)).toEqual([
      'trigger',
      'nickname',
      'topLeftEvidence',
    ])
    expect(crTools.setup.analyzeTrigger).toHaveBeenCalledTimes(1)
    expect(screen.getByText('96%')).toBeVisible()
    expect(await screen.findByTestId('trigger-inner-region')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))

    // 6. outcome, then back to the previous destination without touching the monitor.
    expect(await screen.findByRole('heading', { name: 'Профиль сохранён' })).toBeVisible()
    expect(crTools.setup.review).toHaveBeenCalledTimes(1)
    expect(crTools.setup.commit).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
    expect(crTools.stopMonitor).not.toHaveBeenCalled()
    expect(crTools.startMonitor).not.toHaveBeenCalled()
  })

  it('shows honest manual wording and no automatic scan', async () => {
    mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    expect(screen.getByText(/Автоматического поиска нет/)).toBeVisible()
    expect(screen.queryByText(/сканир/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Чеддер/)).not.toBeInTheDocument()
  })

  it('blocks a 21st profile and explains the limit', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `Профиль ${index + 1}`)
    mountSetup({ name: 'setup' }, { profiles: profilesFixture(names) })
    expect(await screen.findByText('Достигнут предел — 20 профилей')).toBeVisible()
    expect(
      screen.queryByRole('textbox', { name: 'Название профиля' }),
    ).not.toBeInTheDocument()
  })

  it('goes back from the source to the name and keeps the typed name', async () => {
    const world = mountSetup({ name: 'setup' })
    const name = await screen.findByRole('textbox', { name: 'Название профиля' })
    fireEvent.change(name, { target: { value: 'Турнирный' } })
    fireEvent.click(screen.getByRole('button', { name: /Дальше/ }))
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Назад/ }))
    expect(await screen.findByRole('textbox', { name: 'Название профиля' })).toHaveValue(
      'Турнирный',
    )
    // The prepared source is not kept alive.
    expect(world.bridge.crTools.releaseCaptureSource).toHaveBeenCalledWith({
      sourceKey: 'a'.repeat(32),
      revision: 'c'.repeat(32),
    })
  })

  it('reports a freeze failure on the source step and lets the user pick again', async () => {
    const world = mountSetup({ name: 'setup' })
    world.bridge.crTools.startCaptureSetup.mockRejectedValueOnce(
      new Error('Capture profiles changed; refresh and repeat the action'),
    )
    fireEvent.click(await screen.findByRole('button', { name: /Дальше/ }))
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Заморозить кадр/ }))
    expect(
      await screen.findByText(
        'Список профилей изменился, пока шла настройка. Начните заново.',
      ),
    ).toBeVisible()
    // The preparation was consumed: it has to be picked again.
    expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeDisabled()
  })

  it('shows a failed capture session with a way back to the source', async () => {
    const world = mountSetup({ name: 'setup' })
    world.bridge.crTools.startCaptureSetup.mockImplementationOnce(() => {
      world.fake.replace(
        sessionView({
          state: 'FAILED',
          frameSize: null,
          error: { code: 'CAPTURE_NO_FRAME', message: 'No frame' },
        }),
      )
      return Promise.resolve(world.fake.current())
    })
    fireEvent.click(await screen.findByRole('button', { name: /Дальше/ }))
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Заморозить кадр/ }))
    expect(
      await screen.findByRole('heading', { name: 'Настройка не завершена' }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Не удалось получить кадр. Проверьте, что игра открыта и окно не свёрнуто.',
      ),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать источник заново' }))
    expect(
      await screen.findByRole('heading', { name: 'Откуда берём картинку?' }),
    ).toBeVisible()
    expect(world.bridge.crTools.setup.close).toHaveBeenCalledTimes(1)
  })
})

describe('setup flow: pointer region editing', () => {
  async function editor(): Promise<SetupWorld> {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      {
        session: {
          initial: sessionView({
            regions: { ...sessionView().regions, trigger: TRIGGER },
          }),
        },
      },
    )
    await findEditor()
    fireEvent.click(tab(/^Триггер/))
    await screen.findByRole('group', { name: /^Область «Триггер»/ })
    return world
  }
  const activeBox = (): HTMLElement =>
    screen.getByRole('group', { name: /^Область «Триггер»/ })

  it('draws a region and keeps it local until it is saved', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    draw(TRIGGER)
    expect(activeBox().style.left).toBe('10%')
    expect(setRegionCalls(world)).toHaveLength(0)
    fireEvent.click(tab(/^Ник соперника/))
    await waitFor(() => expect(setRegionCalls(world)).toHaveLength(1))
  })

  it('restores the region when the pointer is cancelled mid-drag', async () => {
    await editor()
    const before = activeBox().style.width
    drag([500, 250], [700, 350], { release: false })
    expect(activeBox().style.left).not.toBe('10%')
    fireEvent.pointerCancel(stage(), { pointerId: 1 })
    expect(activeBox().style.left).toBe('10%')
    expect(activeBox().style.width).toBe(before)
    // Nothing is sent and moving after the cancel changes nothing.
    fireEvent.pointerMove(stage(), { clientX: 790, clientY: 390, pointerId: 1 })
    expect(activeBox().style.left).toBe('10%')
  })

  it('restores the region on Escape and ignores the late pointer-up', async () => {
    await editor()
    drag([500, 250], [700, 350], { release: false })
    fireEvent.keyDown(stage(), { key: 'Escape' })
    expect(activeBox().style.left).toBe('10%')
    fireEvent.pointerUp(stage(), { clientX: 700, clientY: 350, pointerId: 1 })
    expect(activeBox().style.left).toBe('10%')
  })

  it('moves the region by its body and resizes it by a corner', async () => {
    await editor()
    // Inside the trigger (80,40)-(240,120): grab the middle and move 100 px right.
    drag([160, 80], [260, 80])
    expect(parseFloat(activeBox().style.left)).toBeCloseTo(22.5)
    expect(parseFloat(activeBox().style.width)).toBeCloseTo(20)
    // Bottom-right corner is now at (340,120): drag it to (440,200).
    drag([340, 120], [440, 200])
    expect(parseFloat(activeBox().style.width)).toBeCloseTo(32.5)
    expect(parseFloat(activeBox().style.height)).toBeCloseTo(40)
    expect(parseFloat(activeBox().style.left)).toBeCloseTo(22.5)
  })

  it('nudges the region with the arrow keys and resizes with Alt', async () => {
    await editor()
    fireEvent.keyDown(activeBox(), { key: 'ArrowRight' })
    expect(parseFloat(activeBox().style.left)).toBeCloseTo(11)
    fireEvent.keyDown(activeBox(), { key: 'ArrowDown', shiftKey: true })
    expect(parseFloat(activeBox().style.top)).toBeCloseTo(15)
    fireEvent.keyDown(activeBox(), { key: 'ArrowRight', altKey: true })
    expect(parseFloat(activeBox().style.width)).toBeCloseTo(21)
  })

  it('reverts a pending change with the revert button', async () => {
    await editor()
    drag([500, 250], [700, 350])
    fireEvent.click(screen.getByRole('button', { name: /Вернуть сохранённую/ }))
    expect(activeBox().style.left).toBe('10%')
  })

  it('does not accept pointer input while a command is running', async () => {
    const world = await editor()
    const pending = Promise.withResolvers<ReturnType<typeof sessionView>>()
    world.bridge.crTools.setup.setRegion.mockImplementationOnce(() => pending.promise)
    draw({ x: 0.5, y: 0.5, width: 0.1, height: 0.1 })
    fireEvent.click(tab(/^Ник соперника/))
    await waitFor(() => expect(world.bridge.crTools.setup.setRegion).toHaveBeenCalled())
    const box = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-region="trigger"]') ?? document.body
    const before = box().style.left
    drag([100, 100], [200, 200])
    expect(box().style.left).toBe(before)
    await act(async () => {
      pending.resolve(sessionView({ generation: 2 }))
      await Promise.resolve()
    })
  })
})

describe('setup flow: stale session and generation', () => {
  it('reloads the session when main rejects a stale generation', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    const calls = world.bridge.crTools.setup.getSession.mock.calls.length
    world.bridge.crTools.setup.setRegion.mockRejectedValueOnce(
      new Error('Error invoking remote method: Error: Setup command is stale'),
    )
    draw(TRIGGER)
    fireEvent.click(tab(/^Ник соперника/))
    await waitFor(() => expect(world.bridge.crTools.setup.setRegion).toHaveBeenCalled())
    expect(
      await screen.findByText('Состояние настройки изменилось. Мы его обновили.'),
    ).toBeVisible()
    await waitFor(() =>
      expect(world.bridge.crTools.setup.getSession.mock.calls.length).toBeGreaterThan(
        calls,
      ),
    )
    // Still on the same region: the draft is not lost.
    expect(screen.getByRole('group', { name: /^Область «Триггер»/ })).toBeVisible()
  })

  it('rejects a reply that does not advance the generation', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    world.bridge.crTools.setup.setRegion.mockResolvedValueOnce(
      sessionView({ generation: 1 }),
    )
    draw(TRIGGER)
    fireEvent.click(tab(/^Ник соперника/))
    await waitFor(() => expect(world.bridge.crTools.setup.setRegion).toHaveBeenCalled())
    expect(
      await screen.findByText(
        'Состояние настройки изменилось. Мы его обновили — повторите шаг.',
      ),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: /^Триггер/, current: 'step' }),
    ).toBeVisible()
  })

  it('rejects a reply that belongs to another session', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    world.bridge.crTools.setup.setRegion.mockResolvedValueOnce(
      sessionView({ sessionId: '00000000-0000-4000-8000-0000000000ff', generation: 2 }),
    )
    draw(TRIGGER)
    fireEvent.click(tab(/^Ник соперника/))
    await waitFor(() => expect(world.bridge.crTools.setup.setRegion).toHaveBeenCalled())
    expect(
      await screen.findByText(
        'Состояние настройки изменилось. Мы его обновили — повторите шаг.',
      ),
    ).toBeVisible()
  })

  it('says the setup is gone when main reports a stale session while closing', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    world.bridge.crTools.setup.cancel.mockRejectedValueOnce(
      new Error('Setup session is stale'),
    )
    world.fake.replace(null)
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    // A session that no longer exists is not a reason to stay on the route.
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
  })

  it('keeps the route and shows the reason when closing really fails', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    world.bridge.crTools.setup.cancel.mockRejectedValueOnce(
      new Error('Configuration is completing its atomic save'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(
      await screen.findByText('Сохранение ещё идёт. Подождите несколько секунд.'),
    ).toBeVisible()
    expect(
      screen.queryByRole('navigation', { name: 'Главная панель' }),
    ).not.toBeInTheDocument()
  })

  it('tells that analysis failed and stays on the regions', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      {
        session: {
          initial: sessionView({
            regions: {
              trigger: TRIGGER,
              nickname: NICK,
              topLeftEvidence: EVIDENCE,
              resultTrigger: null,
              resultData: null,
            },
          }),
        },
      },
    )
    await findEditor()
    world.bridge.crTools.setup.analyzeTrigger.mockImplementationOnce(() =>
      Promise.resolve(
        sessionView({
          generation: 2,
          regions: {
            trigger: TRIGGER,
            nickname: NICK,
            topLeftEvidence: EVIDENCE,
            resultTrigger: null,
            resultData: null,
          },
          error: {
            code: 'SETUP_FAILED',
            message: 'Capture setup could not be completed',
          },
        }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: /Дальше: проверка триггера/ }))
    expect(await screen.findByText(/Не удалось найти устойчивую структуру/)).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Триггер проверен' }),
    ).not.toBeInTheDocument()
  })
})

describe('setup flow: check and save', () => {
  const complete = {
    trigger: TRIGGER,
    nickname: NICK,
    topLeftEvidence: EVIDENCE,
    resultTrigger: null,
    resultData: null,
  }

  async function check(
    grade: 'high' | 'medium' = 'high',
    committed = {},
  ): Promise<SetupWorld> {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      {
        session: {
          initial: sessionView({
            regions: complete,
            triggerProfile: triggerProfile(grade),
          }),
          grade,
          committed,
        },
      },
    )
    await findEditor()
    fireEvent.click(screen.getByRole('button', { name: /Дальше: проверка триггера/ }))
    await screen.findByRole('button', {
      name: /Сохранить профиль|Всё равно сохранить профиль/,
    })
    return world
  }

  it('warns about medium trigger quality but still allows saving', async () => {
    await check('medium')
    expect(
      screen.getByRole('heading', { name: 'Триггер найден, но качество среднее' }),
    ).toBeVisible()
    expect(screen.getByText('71%')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Всё равно сохранить профиль' }),
    ).toBeEnabled()
  })

  it('goes back to the regions to fix them', async () => {
    await check()
    fireEvent.click(screen.getByRole('button', { name: 'Поправить области' }))
    await findEditor()
  })

  it('shows a failed save in review: stale collection cannot be retried', async () => {
    const world = await check()
    world.bridge.crTools.setup.commit.mockImplementationOnce(() => {
      world.fake.replace(
        sessionView({
          generation: 9,
          state: 'REVIEW',
          regions: complete,
          triggerProfile: triggerProfile(),
          error: { code: 'CAPTURE_PROFILE_STALE', message: 'Capture profiles changed' },
        }),
      )
      return Promise.resolve(world.fake.current())
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))
    expect(
      await screen.findByText(
        'Список профилей изменился, пока шла настройка. Отмените её и начните заново.',
      ),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Повторить сохранение' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeEnabled()
  })

  it('offers to retry a failed save when the cause may be temporary', async () => {
    const world = await check()
    world.bridge.crTools.setup.commit.mockImplementationOnce(() => {
      world.fake.replace(
        sessionView({
          generation: 9,
          state: 'REVIEW',
          regions: complete,
          triggerProfile: triggerProfile(),
          error: {
            code: 'SETUP_FAILED',
            message: 'Capture setup could not be completed',
          },
        }),
      )
      return Promise.resolve(world.fake.current())
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить сохранение' }))
    expect(await screen.findByRole('heading', { name: 'Профиль сохранён' })).toBeVisible()
    // The retry commits again but never reviews again.
    expect(world.bridge.crTools.setup.review).toHaveBeenCalledTimes(1)
    expect(world.bridge.crTools.setup.commit).toHaveBeenCalledTimes(2)
  })
})

describe('setup flow: save outcome', () => {
  const complete = {
    trigger: TRIGGER,
    nickname: NICK,
    topLeftEvidence: EVIDENCE,
    resultTrigger: null,
    resultData: null,
  }
  async function saved(
    saveOutcome: NonNullable<ReturnType<typeof sessionView>['saveOutcome']>,
    extra: Partial<ReturnType<typeof sessionView>> = {},
  ): Promise<SetupWorld> {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      {
        session: {
          initial: sessionView({ regions: complete, triggerProfile: triggerProfile() }),
          committed: { saveOutcome, ...extra },
        },
      },
    )
    await findEditor()
    fireEvent.click(screen.getByRole('button', { name: /Дальше: проверка триггера/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить профиль' }))
    await screen.findByRole('region', { name: 'Результат сохранения' })
    return world
  }
  const outcome = () => screen.getByRole('region', { name: 'Результат сохранения' })

  it('says everything is fine only when it is', async () => {
    await saved({ local: 'saved', projection: 'synced', runtime: 'ready', warning: null })
    expect(
      within(outcome()).getByRole('heading', { name: 'Профиль сохранён' }),
    ).toBeVisible()
    expect(within(outcome()).getByText('синхронизировано')).toBeVisible()
    expect(within(outcome()).getByText('готов к работе')).toBeVisible()
    expect(
      within(outcome()).queryByRole('button', { name: 'Повторить отправку' }),
    ).not.toBeInTheDocument()
  })

  it('does not call a local save synchronized: failed sync is retried without saving again', async () => {
    const world = await saved({
      local: 'saved',
      projection: 'failed',
      runtime: 'ready',
      warning: 'SETUP_SYNC_FAILED',
    })
    expect(
      within(outcome()).getByRole('heading', {
        name: 'Профиль сохранён на этом компьютере',
      }),
    ).toBeVisible()
    expect(within(outcome()).getByText('Сервер не получил настройку')).toBeVisible()
    fireEvent.click(within(outcome()).getByRole('button', { name: 'Повторить отправку' }))
    await waitFor(() =>
      expect(within(outcome()).getByText('синхронизировано')).toBeVisible(),
    )
    expect(world.bridge.crTools.setup.retrySync).toHaveBeenCalledTimes(1)
    // Saved once; the retry neither reviews nor commits again.
    expect(world.bridge.crTools.setup.commit).toHaveBeenCalledTimes(1)
    expect(world.bridge.crTools.setup.review).toHaveBeenCalledTimes(1)
  })

  it('keeps the retry available when the retry itself fails', async () => {
    const world = await saved({
      local: 'saved',
      projection: 'failed',
      runtime: 'ready',
      warning: 'SETUP_SYNC_FAILED',
    })
    world.bridge.crTools.setup.retrySync.mockRejectedValueOnce(new Error('network'))
    fireEvent.click(within(outcome()).getByRole('button', { name: 'Повторить отправку' }))
    expect(
      await screen.findByText('Не удалось отправить настройку на сервер. Повторите.'),
    ).toBeVisible()
    expect(
      within(outcome()).getByRole('button', { name: 'Повторить отправку' }),
    ).toBeEnabled()
  })

  it('does not offer to resend an obsolete projection', async () => {
    await saved(
      {
        local: 'saved',
        projection: 'failed',
        runtime: 'ready',
        warning: 'SETUP_SYNC_FAILED',
      },
      { error: { code: 'CAPTURE_PROFILE_STALE', message: 'Reload the saved profile' } },
    )
    expect(within(outcome()).getByText('Отправку повторить нельзя')).toBeVisible()
    expect(
      within(outcome()).queryByRole('button', { name: 'Повторить отправку' }),
    ).not.toBeInTheDocument()
  })

  it('reports a runtime that waits for the source or failed to start', async () => {
    cleanup()
    await saved({
      local: 'saved',
      projection: 'not_required',
      runtime: 'waiting_source',
      warning: null,
    })
    expect(within(outcome()).getByText('Мониторинг ждёт окно игры')).toBeVisible()
    expect(within(outcome()).getByText('не требуется')).toBeVisible()
    cleanup()
    await saved({
      local: 'saved',
      projection: 'synced',
      runtime: 'failed',
      warning: 'SETUP_RUNTIME_FAILED',
    })
    expect(within(outcome()).getByText('Мониторинг не запустился')).toBeVisible()
    expect(within(outcome()).getByText('не запустился')).toBeVisible()
  })

  it('reports a result-zone save with its own wording', async () => {
    mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      {
        session: {
          initial: resultView({
            regions: {
              ...complete,
              trigger: null,
              nickname: null,
              topLeftEvidence: null,
              resultTrigger: TRIGGER,
              resultData: NICK,
            },
            triggerProfile: triggerProfile(),
          }),
          committed: {
            saveOutcome: {
              local: 'saved',
              projection: 'synced',
              runtime: 'not_requested',
              warning: null,
            },
          },
        },
      },
    )
    await findEditor()
    fireEvent.click(screen.getByRole('button', { name: /Дальше: проверка триггера/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить зоны' }))
    expect(
      await screen.findByRole('heading', { name: 'Зоны результата сохранены' }),
    ).toBeVisible()
    expect(screen.getByText('не затронут')).toBeVisible()
  })

  it('closes a finished session with close, not cancel, and returns', async () => {
    const world = await saved({
      local: 'saved',
      projection: 'synced',
      runtime: 'ready',
      warning: null,
    })
    fireEvent.click(within(outcome()).getByRole('button', { name: 'Готово' }))
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
    expect(world.bridge.crTools.setup.close).toHaveBeenCalledTimes(1)
    expect(world.bridge.crTools.setup.cancel).not.toHaveBeenCalled()
    expect(world.bridge.crTools.stopMonitor).not.toHaveBeenCalled()
  })
})

describe('setup flow: cancel, close and back keep monitoring', () => {
  it('cancels only the session, returns to the previous route and never stops the monitor', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      {
        session: { initial: sessionView() },
        monitor: monitorViewFixture({ state: 'READY', runIntent: true }),
      },
    )
    await findEditor()
    expect(screen.getByText('Мониторинг продолжается')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
    expect(world.bridge.crTools.setup.cancel).toHaveBeenCalledWith({
      sessionId: sessionView().sessionId,
      generation: 1,
    })
    expect(world.bridge.crTools.stopMonitor).not.toHaveBeenCalled()
    expect(world.fake.current()?.state).toBe('CANCELLED')
  })

  it('leaves the name step without any session call', async () => {
    const world = mountSetup({ name: 'setup' })
    await screen.findByRole('textbox', { name: 'Название профиля' })
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
    expect(world.bridge.crTools.setup.cancel).not.toHaveBeenCalled()
    expect(world.bridge.crTools.stopMonitor).not.toHaveBeenCalled()
  })

  it('shows what happened when main cancels the session itself', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: sessionView() } },
    )
    await findEditor()
    // Main ended the session (e.g. the account changed): the next command is stale.
    world.fake.replace(sessionView({ generation: 5, state: 'CANCELLED' }))
    draw(TRIGGER)
    fireEvent.click(tab(/^Ник соперника/))
    expect(
      await screen.findByRole('heading', { name: 'Настройка не завершена' }),
    ).toBeVisible()
    expect(
      screen.getByText(
        'Настройка была отменена, например при смене аккаунта. Ничего не сохранено.',
      ),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
    expect(world.bridge.crTools.stopMonitor).not.toHaveBeenCalled()
  })
})

describe('setup flow: source step', () => {
  async function toSource(world: SetupWorld, labelOf: RegExp): Promise<void> {
    void world
    fireEvent.click(await screen.findByRole('button', { name: /Дальше/ }))
    await screen.findByRole('heading', { name: 'Откуда берём картинку?' })
    fireEvent.click(await screen.findByRole('button', { name: labelOf }))
  }

  it('reloads the list after a genuinely stale source and explains it', async () => {
    const world = mountSetup({ name: 'setup' })
    world.bridge.crTools.prepareCaptureSource.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CAPTURE_SOURCE_STALE', message: 'Capture sources changed' },
    })
    await toSource(world, /BlueStacks App Player/)
    await waitFor(() =>
      expect(world.bridge.crTools.listCaptureSources).toHaveBeenCalledTimes(2),
    )
    expect(
      await screen.findByText(
        'Источник изменился. Список обновлён, выберите нужный источник ещё раз.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeDisabled()
  })

  it('ignores a stale failure of a source superseded by a newer pick', async () => {
    const world = mountSetup({ name: 'setup' })
    const base = sourcesFixture()
    const second = base.sources[0]
    if (second === undefined) throw new Error('fixture has no source')
    world.bridge.crTools.listCaptureSources.mockResolvedValue({
      ...base,
      sources: [
        { ...second, label: 'Первое окно' },
        { ...second, sourceKey: 'e'.repeat(32), label: 'Второе окно' },
      ],
    })
    const first = Promise.withResolvers<{
      ok: false
      error: { code: string; message: string }
    }>()
    world.bridge.crTools.prepareCaptureSource.mockReturnValueOnce(first.promise)
    await toSource(world, /Первое окно/)
    fireEvent.click(await screen.findByRole('button', { name: /Второе окно/ }))
    await waitFor(() =>
      expect(world.bridge.crTools.prepareCaptureSource).toHaveBeenCalledTimes(2),
    )
    await act(async () => {
      first.resolve({
        ok: false,
        error: { code: 'CAPTURE_SOURCE_STALE', message: 'stale' },
      })
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeEnabled(),
    )
    expect(world.bridge.crTools.listCaptureSources).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Источник изменился/)).not.toBeInTheDocument()
  })

  it('shows a capture timeout without suggesting a list refresh', async () => {
    const world = mountSetup({ name: 'setup' })
    world.bridge.crTools.prepareCaptureSource.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CAPTURE_PREPARATION_TIMEOUT', message: 'timeout' },
    })
    await toSource(world, /BlueStacks App Player/)
    expect(
      await screen.findByText(
        'Захват не запустился за 8 секунд. Убедитесь, что источник доступен и не свёрнут, затем повторите выбор.',
      ),
    ).toBeVisible()
    expect(world.bridge.crTools.listCaptureSources).toHaveBeenCalledTimes(1)
  })

  it('uses source-neutral wording when a screen cannot be captured', async () => {
    const world = mountSetup({ name: 'setup' })
    world.bridge.crTools.prepareCaptureSource.mockResolvedValueOnce({
      ok: false,
      error: { code: 'CAPTURE_PREPARATION_START_FAILED', message: 'failed' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Дальше/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Экраны · 1/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Экран 2/ }))
    expect(
      await screen.findByText(
        'Служба захвата не запустилась. Повторите выбор источника.',
      ),
    ).toBeVisible()
  })

  it('releases the prepared source when the tab changes and keeps freeze disabled', async () => {
    const world = mountSetup({ name: 'setup' })
    await toSource(world, /BlueStacks App Player/)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Экраны · 1/ }))
    expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeDisabled()
    expect(world.bridge.crTools.releaseCaptureSource).toHaveBeenCalledWith({
      sourceKey: 'a'.repeat(32),
      revision: 'c'.repeat(32),
    })
  })

  it('says so when the list of sources cannot be loaded', async () => {
    const world = mountSetup({ name: 'setup' })
    world.bridge.crTools.listCaptureSources.mockRejectedValueOnce(new Error('IPC'))
    fireEvent.click(await screen.findByRole('button', { name: /Дальше/ }))
    expect(
      await screen.findByText(
        'Не удалось получить источники. Захват доступен только в Windows.',
      ),
    ).toBeVisible()
  })
})

describe('setup flow: resume and result zones', () => {
  it('resumes a result-zone session: two regions, check, save', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'resume' } },
      { session: { initial: resultView({ profileName: 'Основной' }) } },
    )
    await findEditor()
    expect(screen.getByRole('button', { name: /^Триггер результата/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Зона с итогом/ })).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /^Ник соперника/ }),
    ).not.toBeInTheDocument()
    draw(TRIGGER)
    fireEvent.click(tab(/^Зона с итогом/))
    await waitFor(() => expect(setRegionCalls(world)).toHaveLength(1))
    expect(setRegionCalls(world)[0]?.region).toBe('resultTrigger')
    draw(NICK)
    fireEvent.click(screen.getByRole('button', { name: /Дальше: проверка триггера/ }))
    await screen.findByRole('heading', { name: 'Триггер проверен' })
    expect(setRegionCalls(world).map((call) => call.region)).toEqual([
      'resultTrigger',
      'resultData',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить зоны' }))
    expect(
      await screen.findByRole('heading', { name: 'Зоны результата сохранены' }),
    ).toBeVisible()
  })

  it('says there is no setup to resume', async () => {
    mountSetup({ name: 'setup', intent: { kind: 'resume' } })
    expect(await screen.findByText(/Начатой настройки нет/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
  })

  it('adopts an already open session instead of failing with "already active"', async () => {
    const world = mountSetup(
      { name: 'setup', intent: { kind: 'new' } },
      { session: { initial: sessionView({ profileName: 'Начатый' }) } },
    )
    await findEditor()
    expect(screen.getByText(/Замороженный кадр · Экран 2/)).toBeVisible()
    expect(world.bridge.crTools.startCaptureSetup).not.toHaveBeenCalled()
  })
})

describe('setup flow: existing profile intents', () => {
  const intent = {
    profileId: PROFILE_ID,
    profileName: 'Основной',
    expectedRevision: 1,
  }

  it('recalibrates an existing profile: no name step, same profile id', async () => {
    const world = mountSetup({
      name: 'setup',
      intent: { kind: 'recalibrate', ...intent },
    })
    expect(
      await screen.findByRole('heading', { name: 'Перенастройка «Основной»' }),
    ).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Заморозить кадр/ })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Заморозить кадр/ }))
    await findEditor()
    expect(world.bridge.crTools.startCaptureSetup).toHaveBeenCalledWith({
      preparationId: '00000000-0000-4000-8000-0000000000b1',
      profileId: PROFILE_ID,
      profileName: 'Основной',
      expectedRevision: 1,
    })
  })

  it('rebinds only the source and returns with a toast', async () => {
    const world = mountSetup({ name: 'setup', intent: { kind: 'rebind', ...intent } })
    world.bridge.crTools.rebindCaptureProfile.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        profiles: profilesFixture(['Основной']),
        monitor: monitorViewFixture({ state: 'READY', runIntent: true }),
        capture: { configured: true, revision: 2, sourceLabel: 'BlueStacks' },
      }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Новый источник для «Основной»' }),
    ).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Привязать источник/ })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Привязать источник/ }))
    expect(await screen.findByText('Источник профиля «Основной» обновлён.')).toBeVisible()
    expect(world.bridge.crTools.rebindCaptureProfile).toHaveBeenCalledWith({
      preparationId: '00000000-0000-4000-8000-0000000000b1',
      profileId: PROFILE_ID,
      expectedRevision: 1,
    })
    expect(world.bridge.crTools.startCaptureSetup).not.toHaveBeenCalled()
    expect(
      await screen.findByRole('navigation', { name: 'Главная панель' }),
    ).toBeVisible()
  })

  it('keeps the step open with the reason when the rebind is refused', async () => {
    const world = mountSetup({ name: 'setup', intent: { kind: 'rebind', ...intent } })
    world.bridge.crTools.rebindCaptureProfile.mockResolvedValue({
      ok: false,
      error: { code: 'CAPTURE_PROFILE_STALE' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Привязать источник/ })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /Привязать источник/ }))
    expect(
      await screen.findByText(
        'Список профилей изменился. Мы его обновили — повторите действие.',
      ),
    ).toBeVisible()
    expect(
      screen.queryByRole('navigation', { name: 'Главная панель' }),
    ).not.toBeInTheDocument()
  })
})
