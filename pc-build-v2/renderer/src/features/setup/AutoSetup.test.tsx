// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AutoSetupCode } from '../../../../shared/contracts/auto-setup'
import type { SetupSessionView } from '../../../../shared/models/setup'
import {
  detectedView,
  detectingView,
  failedDetectionView,
  type SetupFakeOptions,
} from '../../test/setupFake'
import { mountSetup, stubStageGeometry, type SetupWorld } from '../../test/setupWorld'

const WAIT = 'Зайдите в тренировочный бой с Тренером Чеддером'
const GENERIC = 'Не получилось настроить автоматически'
const LOST = 'Окно игры закрыто или свёрнуто'
const RESUME = { name: 'setup', intent: { kind: 'resume' } } as const

/** Everything the owner removed: no phases, scores, formats, name check or badges. */
const FORBIDDEN =
  /VS|уверенн|оценк|качеств|формат|Значок|дополнен|Имя на кадре|Игра найдена|AUTO_|%/

function mountAuto(
  initial: SetupSessionView,
  session: Omit<SetupFakeOptions, 'initial'> = {},
): SetupWorld {
  return mountSetup(RESUME, { session: { initial, ...session } })
}

function live(world: SetupWorld): SetupSessionView {
  const current = world.fake.current()
  if (current === null) throw new Error('No setup session')
  return current
}

const button = (name: string | RegExp): HTMLElement =>
  screen.getByRole('button', { name })
const heading = (name: string): Promise<HTMLElement> =>
  screen.findByRole('heading', { name })
const stepLabels = (): string[] =>
  within(screen.getByRole('list', { name: 'Этапы настройки' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent.replace(/^\P{L}+/u, ''))
    .filter((text) => text !== '')
async function findEditor(): Promise<void> {
  await heading('Отметьте области вручную')
  await within(
    await screen.findByRole('group', { name: 'Выделение области на рабочем кадре' }),
  ).findByRole('img')
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

let created = 0
const createObjectURL = vi.fn(() => `blob:preview-${(created += 1)}`)
const revokeObjectURL = vi.fn()

beforeEach(() => {
  stubStageGeometry()
  created = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURL,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('automatic setup: entry', () => {
  it('makes automatic setup the main action of the source step and keeps manual setup', async () => {
    const world = mountSetup({ name: 'setup' })
    fireEvent.click(await screen.findByRole('button', { name: /Дальше/ }))
    await heading('Откуда берём картинку?')
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Бой', 'Готово'])
    const auto = button(/Дальше: автонастройка/)
    expect(auto).toBeDisabled()
    expect(button('Настроить вручную')).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    await waitFor(() => expect(auto).toBeEnabled())
    fireEvent.click(auto)

    await heading(WAIT)
    expect(world.bridge.crTools.startCaptureSetup).toHaveBeenCalledWith({
      mode: 'auto',
      preparationId: '00000000-0000-4000-8000-0000000000b1',
      profileId: null,
      profileName: 'Профиль 2',
      expectedRevision: expect.any(Number) as number,
    })
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Бой', 'Готово'])
    expect(world.bridge.crTools.setup.switchToManual).not.toHaveBeenCalled()
  })

  it('starts the manual flow from the same source step', async () => {
    const world = mountSetup({ name: 'setup' })
    fireEvent.click(await screen.findByRole('button', { name: /Дальше/ }))
    await heading('Откуда берём картинку?')
    fireEvent.click(await screen.findByRole('button', { name: /BlueStacks App Player/ }))
    const manual = button('Настроить вручную')
    await waitFor(() => expect(manual).toBeEnabled())
    fireEvent.click(manual)
    await findEditor()
    expect(world.bridge.crTools.startCaptureSetup).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'manual' }),
    )
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Области', 'Проверка'])
  })
})

describe('automatic setup: waiting', () => {
  it('shows only the sentence, the live picture and a real 60-second countdown', async () => {
    vi.useFakeTimers()
    mountAuto(detectingView())
    await tick(50)
    expect(screen.getByRole('heading', { name: WAIT })).toBeVisible()
    expect(screen.getByRole('timer')).toHaveTextContent('1:00')
    expect(screen.getByRole('img', { name: 'Картинка окна игры' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:preview-/),
    )
    expect(document.body.textContent).not.toMatch(FORBIDDEN)
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Бой', 'Готово'])

    await tick(15_000)
    expect(screen.getByRole('timer')).toHaveTextContent('0:45')
    await tick(60_000)
    expect(screen.getByRole('timer')).toHaveTextContent('0:00')
  })

  it('polls the preview about once a second, revokes every replaced URL and stops on unmount', async () => {
    vi.useFakeTimers()
    const world = mountAuto(detectingView())
    const preview = world.bridge.crTools.setup.getDetectionPreview
    await tick(50)
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenCalledWith({ sessionId: detectingView().sessionId })
    await tick(3_000)
    expect(preview.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(preview.mock.calls.length).toBeLessThanOrEqual(5)
    // Only the newest picture stays alive.
    expect(revokeObjectURL).toHaveBeenCalledTimes(createObjectURL.mock.calls.length - 1)

    cleanup()
    expect(revokeObjectURL).toHaveBeenCalledTimes(createObjectURL.mock.calls.length)
    const calls = preview.mock.calls.length
    await tick(5_000)
    expect(preview).toHaveBeenCalledTimes(calls)
  })

  it('shows a placeholder, not a broken picture, until the first preview exists', async () => {
    mountAuto(detectingView(), { preview: null })
    await heading(WAIT)
    expect(screen.queryByRole('img', { name: 'Картинка окна игры' })).toBeNull()
    expect(screen.getByRole('status', { name: 'Ждём картинку окна' })).toBeVisible()
    const spinner = screen.getByRole('status', { name: 'Ждём картинку окна' })
    expect(spinner).toBeEmptyDOMElement()
    expect(document.body.textContent).not.toContain('Ждём картинку окна')
  })

  it('keeps the transient opening spinner label out of visible setup text', async () => {
    mountAuto(detectingView({ detection: null }))
    const spinner = await screen.findByRole('status', { name: 'Открываем настройку' })
    expect(spinner).toBeEmptyDOMElement()
    expect(document.body.textContent).not.toContain('Открываем настройку')
  })

  it('keeps polling the session and shows the result when main succeeds', async () => {
    vi.useFakeTimers()
    const world = mountAuto(detectingView())
    await tick(50)
    world.fake.replace(detectedView({ generation: 1 }))
    await tick(900)
    expect(screen.getByRole('heading', { name: 'Готово' })).toBeVisible()
    expect(screen.queryByRole('timer')).toBeNull()
    expect(world.bridge.crTools.setup.getFrame).toHaveBeenCalledWith({
      sessionId: detectingView().sessionId,
      generation: 1,
    })
    // The picture poll ended with the wait.
    const calls = world.bridge.crTools.setup.getDetectionPreview.mock.calls.length
    await tick(3_000)
    expect(world.bridge.crTools.setup.getDetectionPreview).toHaveBeenCalledTimes(calls)
  })

  it('cancels the whole setup from the top bar', async () => {
    const world = mountAuto(detectingView())
    await heading(WAIT)
    fireEvent.click(button(/Отмена/))
    await waitFor(() =>
      expect(world.bridge.crTools.setup.cancel).toHaveBeenCalledWith({
        sessionId: detectingView().sessionId,
        generation: 0,
      }),
    )
  })

  it('switches to the manual editor of the same session and uses the new generation', async () => {
    const world = mountAuto(detectingView())
    await heading(WAIT)
    fireEvent.click(button('Настроить вручную'))
    await findEditor()
    const { setup, startCaptureSetup } = world.bridge.crTools
    expect(setup.switchToManual).toHaveBeenCalledWith({
      sessionId: detectingView().sessionId,
      generation: 0,
    })
    expect(startCaptureSetup).not.toHaveBeenCalled()
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Области', 'Проверка'])
  })
})

describe('automatic setup: failures', () => {
  const OTHER: AutoSetupCode[] = [
    'AUTO_GAME_NOT_FOUND',
    'AUTO_ASPECT_UNSUPPORTED',
    'AUTO_LAYOUT_UNEXPECTED',
    'AUTO_NICKNAME_ZONE_CLIPPED',
    'AUTO_TRIGGER_WEAK',
    'AUTO_SELF_CHECK_FAILED',
    'AUTO_INTERNAL_TIMEOUT',
    'AUTO_INTERNAL_ERROR',
  ]
  const CASES: readonly (readonly [AutoSetupCode, string, boolean])[] = [
    ['AUTO_VS_TIMEOUT', 'Экран боя не появился за минуту', false],
    ['AUTO_SOURCE_LOST', LOST, true],
    ...OTHER.map((code) => [code, GENERIC, false] as const),
  ]

  it.each(CASES)(
    '%s shows exactly one phrase and its actions',
    async (code, phrase, lost) => {
      const world = mountAuto(failedDetectionView(code))
      await heading(phrase)
      expect(document.body.textContent).not.toMatch(FORBIDDEN)
      expect(screen.getAllByRole('heading')).toHaveLength(1)
      expect(button('Настроить вручную')).toBeEnabled()
      expect(screen.queryByRole('button', { name: 'Попробовать ещё раз' }) === null).toBe(
        lost,
      )
      expect(screen.queryByRole('button', { name: 'Выбрать окно' }) !== null).toBe(lost)
      expect(screen.queryByRole('timer')).toBeNull()
      expect(world.bridge.crTools.setup.getDetectionPreview).not.toHaveBeenCalled()
      expect(stepLabels()).toEqual(['Название', 'Источник', 'Бой', 'Готово'])
    },
  )

  it('retries with the current generation and waits again', async () => {
    const world = mountAuto(failedDetectionView('AUTO_VS_TIMEOUT'))
    fireEvent.click(await screen.findByRole('button', { name: 'Попробовать ещё раз' }))
    await heading(WAIT)
    expect(world.bridge.crTools.setup.retryDetection).toHaveBeenCalledWith({
      sessionId: detectingView().sessionId,
      generation: 1,
    })
    expect(screen.getByRole('timer')).toHaveTextContent(/^(1:00|0:59)$/)
    await waitFor(() =>
      expect(world.bridge.crTools.setup.getDetectionPreview).toHaveBeenCalled(),
    )
  })

  it('moves to the manual editor from a failure', async () => {
    const world = mountAuto(failedDetectionView('AUTO_TRIGGER_WEAK'))
    fireEvent.click(await screen.findByRole('button', { name: 'Настроить вручную' }))
    await findEditor()
    expect(world.bridge.crTools.setup.switchToManual).toHaveBeenCalledWith({
      sessionId: detectingView().sessionId,
      generation: 1,
    })
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Области', 'Проверка'])
  })

  it('refuses a stale retry, reloads the session and retries with its generation', async () => {
    const world = mountAuto(failedDetectionView('AUTO_VS_TIMEOUT'))
    await heading('Экран боя не появился за минуту')
    // Main moved on without this window noticing.
    world.fake.replace(failedDetectionView('AUTO_TRIGGER_WEAK', { generation: 4 }))
    fireEvent.click(button('Попробовать ещё раз'))
    expect(await screen.findByText(/Состояние настройки изменилось/)).toBeVisible()
    await heading(GENERIC)
    fireEvent.click(button('Попробовать ещё раз'))
    await heading(WAIT)
    expect(world.bridge.crTools.setup.retryDetection).toHaveBeenLastCalledWith({
      sessionId: detectingView().sessionId,
      generation: 4,
    })
  })

  it('goes back to the source step with «Выбрать окно» when the window is gone', async () => {
    const world = mountAuto(failedDetectionView('AUTO_SOURCE_LOST'))
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать окно' }))
    await heading('Откуда берём картинку?')
    expect(world.bridge.crTools.setup.cancel).toHaveBeenCalledWith({
      sessionId: detectingView().sessionId,
      generation: 1,
    })
  })

  it('turns a retry that finds the window gone into the source-lost screen', async () => {
    const world = mountAuto(failedDetectionView('AUTO_VS_TIMEOUT'))
    world.bridge.crTools.setup.retryDetection.mockRejectedValueOnce(
      Object.assign(new Error('Private source failure'), { code: 'SETUP_SOURCE_LOST' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Попробовать ещё раз' }))
    await heading(LOST)
    expect(screen.queryByRole('button', { name: 'Попробовать ещё раз' })).toBeNull()
    expect(button('Выбрать окно')).toBeEnabled()
    expect(button('Настроить вручную')).toBeEnabled()
    expect(screen.queryByText(LOST, { selector: 'p, span, div' })).toBeNull()
    expect(world.bridge.crTools.setup.retryDetection).toHaveBeenCalledTimes(1)
  })

  it('does not infer a lost source from an unrelated command message', async () => {
    const world = mountAuto(failedDetectionView('AUTO_VS_TIMEOUT'))
    world.bridge.crTools.setup.retryDetection.mockRejectedValueOnce(
      Object.assign(new Error(LOST), { code: 'SETUP_ANALYSIS_BUSY' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Попробовать ещё раз' }))
    await screen.findByText(LOST)
    expect(
      screen.getByRole('heading', { name: 'Экран боя не появился за минуту' }),
    ).toBeVisible()
    expect(button('Попробовать ещё раз')).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Выбрать окно' })).toBeNull()
  })

  it('offers a new source rather than a dead retry after an internal capture failure', async () => {
    const world = mountAuto(failedDetectionView('AUTO_VS_TIMEOUT'))
    world.bridge.crTools.setup.retryDetection.mockRejectedValueOnce(
      Object.assign(new Error('private process failure'), {
        code: 'SETUP_CAPTURE_UNAVAILABLE',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Попробовать ещё раз' }))
    await heading(GENERIC)
    expect(screen.getAllByRole('heading')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(
      /private process failure|закрыто|свёрнуто/,
    )
    expect(screen.queryByRole('button', { name: 'Попробовать ещё раз' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Настроить вручную' })).toBeNull()
    fireEvent.click(button('Выбрать окно'))
    await heading('Откуда берём картинку?')
    expect(world.bridge.crTools.setup.cancel).toHaveBeenCalledTimes(1)
  })

  it('shows the source-lost phrase when switching to manual finds no window', async () => {
    const world = mountAuto(failedDetectionView('AUTO_VS_TIMEOUT'))
    world.bridge.crTools.setup.switchToManual.mockImplementationOnce(() => {
      const current = live(world)
      world.fake.replace({
        ...current,
        state: 'FAILED',
        generation: current.generation + 1,
        error: { code: 'SETUP_SOURCE_LOST', message: 'private internals' },
      })
      return Promise.resolve(world.fake.current())
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Настроить вручную' }))
    await heading(LOST)
    expect(document.body.textContent).not.toMatch(/private internals/)
    expect(screen.queryByRole('button', { name: 'Попробовать ещё раз' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Настроить вручную' })).toBeNull()
    fireEvent.click(button('Выбрать окно'))
    await heading('Откуда берём картинку?')
    expect(world.bridge.crTools.setup.close).toHaveBeenCalledTimes(1)
  })
})

describe('automatic setup: success', () => {
  it('shows «Готово», the frame with the three zones and the two buttons only', async () => {
    mountAuto(detectedView())
    await heading('Готово')
    const frame = await screen.findByRole('group', {
      name: 'Выделение области на рабочем кадре',
    })
    await within(frame).findByRole('img')
    for (const label of ['Триггер', 'Ник соперника', 'Левая верхняя область'])
      expect(within(frame).getByText(label)).toBeVisible()
    // The trigger is drawn as the compared VS silhouette; its label sits on the outline.
    const shape = within(frame).getByTestId('outline-trigger')
    expect(
      shape.querySelector('polygon')?.getAttribute('points')?.split(' '),
    ).toHaveLength(detectedView().triggerOutline?.length ?? 0)
    const trigger = frame.querySelector<HTMLElement>('[data-region="trigger"]')
    expect(trigger?.style.left).toBe('48%')
    expect(button('Сохранить')).toBeEnabled()
    expect(button('Поправить вручную')).toBeEnabled()
    expect(document.body.textContent).not.toMatch(FORBIDDEN)
    expect(document.body.textContent).not.toMatch(/Чеддер|Тренер/)
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Бой', 'Готово'])
  })

  it('saves through review and commit without analysing or touching a zone', async () => {
    const world = mountAuto(detectedView())
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
    expect(await heading('Профиль сохранён')).toBeVisible()
    const { setup } = world.bridge.crTools
    expect(setup.review).toHaveBeenCalledWith({
      sessionId: detectedView().sessionId,
      generation: 2,
    })
    expect(setup.commit).toHaveBeenCalledTimes(1)
    for (const untouched of [
      setup.analyzeTrigger,
      setup.setRegion,
      setup.finish,
      setup.retryDetection,
      setup.switchToManual,
    ])
      expect(untouched).not.toHaveBeenCalled()
  })

  it('opens the same session in the manual editor with the zones in place', async () => {
    const world = mountAuto(detectedView())
    fireEvent.click(await screen.findByRole('button', { name: 'Поправить вручную' }))
    await findEditor()
    const { setup, startCaptureSetup } = world.bridge.crTools
    expect(setup.switchToManual).not.toHaveBeenCalled()
    expect(startCaptureSetup).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Готово' })).toBeNull()
    expect(stepLabels()).toEqual(['Название', 'Источник', 'Области', 'Проверка'])
    // The automatic zones are already there: all three can go straight to the check.
    expect(button(/Дальше: проверка триггера/)).toBeEnabled()
    expect(world.fake.current()?.sessionId).toBe(detectedView().sessionId)
  })

  it('offers a retry of a failed save and still never reanalyses', async () => {
    const world = mountAuto(detectedView())
    world.bridge.crTools.setup.commit.mockImplementationOnce(() => {
      world.fake.replace({
        ...live(world),
        generation: 4,
        error: { code: 'SETUP_SAVE_FAILED', message: 'x' },
      })
      return Promise.resolve(world.fake.current())
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить сохранение' }))
    expect(await heading('Профиль сохранён')).toBeVisible()
    expect(world.bridge.crTools.setup.review).toHaveBeenCalledTimes(1)
    expect(world.bridge.crTools.setup.analyzeTrigger).not.toHaveBeenCalled()
  })
})
