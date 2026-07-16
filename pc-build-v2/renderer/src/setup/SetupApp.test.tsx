// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CrToolsSetupApi } from '../../../shared/contracts/preload'
import type { NormalizedRect, TriggerProfile } from '../../../shared/models/capture'
import type { SetupFrame, SetupSessionView } from '../../../shared/models/setup'
import { SetupApp } from './SetupApp'

const TRIGGER: NormalizedRect = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }
const NORMAL: NormalizedRect = { x: 0.3, y: 0.2, width: 0.2, height: 0.2 }
const PRECISE: NormalizedRect = { x: 0.15, y: 0.15, width: 0.6, height: 0.6 }

const PROFILE: TriggerProfile = {
  schemaVersion: 2,
  analyzer: { name: 'cr-tools-trigger-analyzer', version: '1.0.0' },
  hashAlgorithm: 'ahash64-bitwise-v1',
  ahash64: '0123456789abcdef',
  innerRect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  featureMode: 'orb',
  keypointsCount: 12,
  normalizedTemplateSize: { width: 64, height: 64 },
  templateGrayBase64: 'dGVzdA==',
  hashMaxDistance: 8,
  orbDistanceThreshold: 40,
  orbMinGoodMatches: 4,
  nccMinScore: 0.8,
}

function setupView(overrides: Partial<SetupSessionView> = {}): SetupSessionView {
  const base: SetupSessionView = {
    kind: 'capture',
    sessionId: '00000000-0000-4000-8000-000000000001',
    generation: 7,
    state: 'SELECTING',
    source: { kind: 'display', label: 'Основной экран', displayId: 'display-1' },
    frameSize: { width: 800, height: 450 },
    regions: {
      trigger: TRIGGER,
      normal: NORMAL,
      precise: PRECISE,
      resultTrigger: null,
      resultData: null,
    },
    triggerProfile: null,
    error: null,
  }
  return { ...base, ...overrides }
}

function setupFrame(view: SetupSessionView): SetupFrame {
  return {
    sessionId: view.sessionId,
    generation: view.generation,
    size: view.frameSize ?? { width: 800, height: 450 },
    byteLength: 1,
    mimeType: 'image/png',
    bytes: new Uint8Array([1]),
  }
}

function installApi(initial: SetupSessionView, overrides: Partial<CrToolsSetupApi> = {}) {
  let current = initial
  const getSession = vi.fn(() => Promise.resolve(current))
  const getFrame = vi.fn(() => Promise.resolve(setupFrame(current)))
  const setRegion = vi.fn<CrToolsSetupApi['setRegion']>((payload) => {
    current = {
      ...current,
      generation: payload.generation + 1,
      regions: { ...current.regions, [payload.region]: payload.rect },
      triggerProfile:
        payload.region === 'trigger' || payload.region === 'resultTrigger'
          ? null
          : current.triggerProfile,
      error: null,
    }
    return Promise.resolve(current)
  })
  const advance = (): Promise<SetupSessionView> => {
    current = { ...current, generation: current.generation + 1 }
    return Promise.resolve(current)
  }
  const api: CrToolsSetupApi = Object.freeze({
    getSession,
    getFrame,
    setRegion,
    analyzeTrigger: vi.fn(advance),
    review: vi.fn(advance),
    commit: vi.fn(advance),
    cancel: vi.fn(advance),
    close: vi.fn(advance),
    ...overrides,
  })
  Object.defineProperty(window, 'crToolsSetup', {
    configurable: true,
    value: api,
  })
  return { getFrame, getSession, setRegion }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function renderSetup(): Promise<void> {
  render(<SetupApp />)
  await screen.findByRole('heading', { name: 'Области распознавания' })
}

describe('SetupApp', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:setup-frame'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
      },
    )
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 450,
      width: 800,
      height: 450,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps undo history strictly per region', async () => {
    const { setRegion } = installApi(setupView())
    await renderSetup()

    fireEvent.change(screen.getByLabelText('X'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Применить координаты' }))
    await waitFor(() => expect(setRegion).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Быстрый поиск\./ })).toBeEnabled(),
    )

    fireEvent.click(screen.getByRole('button', { name: /^Быстрый поиск\./ }))
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '35' } })
    fireEvent.click(screen.getByRole('button', { name: 'Применить координаты' }))
    await waitFor(() => expect(setRegion).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Триггер\./ })).toBeEnabled(),
    )

    fireEvent.click(screen.getByRole('button', { name: /^Триггер\./ }))
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(() => expect(setRegion).toHaveBeenCalledTimes(3))

    expect(setRegion).toHaveBeenLastCalledWith({
      sessionId: '00000000-0000-4000-8000-000000000001',
      generation: 9,
      region: 'trigger',
      rect: TRIGGER,
    })
  })

  it('keeps pointer drawing local until the explicit apply action', async () => {
    const initial = setupView({
      regions: {
        ...setupView().regions,
        trigger: null,
      },
    })
    const { setRegion } = installApi(initial)
    await renderSetup()
    await screen.findByRole('img', { name: 'Кадр выбранного источника' })

    const stage = screen.getByRole('group', {
      name: 'Выделение области на рабочем кадре',
    })
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 80, clientY: 45 })
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 320, clientY: 225 })
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 320, clientY: 225 })

    expect(setRegion).not.toHaveBeenCalled()
    expect(screen.getByLabelText('X')).toHaveValue(10)
    const apply = screen.getByRole('button', { name: 'Применить координаты' })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    await waitFor(() => expect(setRegion).toHaveBeenCalledTimes(1))
  })

  it('cancels pointer drafts and releases pointer capture', async () => {
    const { setRegion } = installApi(setupView())
    await renderSetup()
    await screen.findByRole('img', { name: 'Кадр выбранного источника' })

    const stage = screen.getByRole('group', {
      name: 'Выделение области на рабочем кадре',
    })
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    Object.defineProperties(stage, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: () => true },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
    })

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 80, clientY: 45 })
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 320, clientY: 225 })
    expect(screen.getByLabelText('WIDTH')).toHaveValue(30)
    fireEvent.pointerCancel(stage, { pointerId: 1 })

    expect(setPointerCapture).toHaveBeenCalledTimes(1)
    expect(releasePointerCapture).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('X')).toHaveValue(10)
    expect(screen.getByLabelText('WIDTH')).toHaveValue(20)
    expect(setRegion).not.toHaveBeenCalled()
  })

  it('locks conflicting controls and ignores a stale persist response', async () => {
    const initial = setupView({ triggerProfile: PROFILE })
    const pending = deferred<SetupSessionView>()
    const setRegion = vi.fn<CrToolsSetupApi['setRegion']>(() => pending.promise)
    installApi(initial, { setRegion })
    await renderSetup()

    fireEvent.change(screen.getByLabelText('X'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Применить координаты' }))

    expect(screen.getByRole('button', { name: /^Быстрый поиск\./ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Проверка\./ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Перейти к проверке' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Отменить и закрыть' })).toBeDisabled()
    expect(screen.getByLabelText('X')).toBeDisabled()
    expect(
      screen.getByRole('group', { name: 'Выделение области на рабочем кадре' }),
    ).toHaveAttribute('data-editable', 'false')

    await act(async () => {
      pending.resolve(
        setupView({
          generation: initial.generation + 2,
          state: 'REVIEW',
          triggerProfile: PROFILE,
        }),
      )
      await pending.promise
    })

    expect(
      await screen.findByText(
        'Состояние настройки изменилось. Повторно выберите область.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('main')).toHaveAttribute('data-state', 'SELECTING')
    expect(screen.getByLabelText('X')).toBeEnabled()
  })

  it('retries initial session and frame errors instead of spinning forever', async () => {
    const initial = setupView()
    const getSession = vi
      .fn<CrToolsSetupApi['getSession']>()
      .mockRejectedValueOnce(new Error('Session IPC unavailable'))
      .mockResolvedValue(initial)
    const getFrame = vi
      .fn<CrToolsSetupApi['getFrame']>()
      .mockRejectedValueOnce(new Error('IPC unavailable'))
      .mockResolvedValue(setupFrame(initial))
    installApi(initial, { getFrame, getSession })

    render(<SetupApp />)
    expect(
      await screen.findByRole('heading', { name: 'Не удалось загрузить настройку' }),
    ).toBeVisible()
    expect(screen.queryByText('Подготовка рабочего кадра')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(getFrame).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByRole('heading', { name: 'Не удалось загрузить настройку' }),
    ).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(
      await screen.findByRole('heading', { name: 'Области распознавания' }),
    ).toBeVisible()
    expect(getSession).toHaveBeenCalledTimes(3)
    expect(getFrame).toHaveBeenCalledTimes(2)
  })

  it('keeps incomplete numeric input local until all coordinates are valid', async () => {
    const initial = setupView({
      regions: {
        ...setupView().regions,
        trigger: null,
      },
    })
    const { setRegion } = installApi(initial)
    await renderSetup()

    const apply = screen.getByRole('button', { name: 'Применить координаты' })
    expect(screen.getByLabelText('X')).toHaveValue(null)
    fireEvent.change(screen.getByLabelText('X'), { target: { value: '10' } })
    expect(screen.getByLabelText('X')).toHaveValue(10)
    expect(apply).toBeDisabled()
    expect(setRegion).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Y'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('WIDTH'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('HEIGHT'), { target: { value: '20' } })
    expect(apply).toBeEnabled()

    fireEvent.change(screen.getByLabelText('WIDTH'), { target: { value: '' } })
    expect(screen.getByLabelText('WIDTH')).toHaveValue(null)
    expect(apply).toBeDisabled()
    expect(setRegion).not.toHaveBeenCalled()
  })

  it('disables coordinate fields and pointer editing in review', async () => {
    installApi(setupView({ state: 'REVIEW', triggerProfile: PROFILE }))
    await renderSetup()

    expect(screen.getByLabelText('X')).toBeDisabled()
    expect(screen.getByLabelText('Y')).toBeDisabled()
    expect(screen.getByLabelText('WIDTH')).toBeDisabled()
    expect(screen.getByLabelText('HEIGHT')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Применить координаты' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Проверка\./ })).toHaveAttribute(
      'aria-current',
      'step',
    )
    const normalStep = screen.getByRole('button', { name: /^Быстрый поиск\./ })
    expect(normalStep).toBeEnabled()
    fireEvent.click(normalStep)
    expect(screen.getByRole('heading', { name: 'Быстрый поиск' })).toBeVisible()
    expect(screen.getByLabelText('X')).toBeDisabled()
    expect(
      screen.getByRole('group', { name: 'Выделение области на рабочем кадре' }),
    ).toHaveAttribute('data-editable', 'false')
  })
})
