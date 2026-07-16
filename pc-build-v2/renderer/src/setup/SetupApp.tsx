import { ArrowLeft, Check, RotateCcw, ScanLine, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { NormalizedRect, RegionKind } from '../../../shared/models/capture'
import type { SetupSessionView } from '../../../shared/models/setup'
import {
  containTransform,
  pointerToNormalized,
  rectFromPoints,
  type ContainTransform,
} from './geometry'

const STEPS: readonly { id: RegionKind; label: string; help: string }[] = [
  {
    id: 'trigger',
    label: 'Триггер',
    help: 'Выделите устойчивый элемент экрана начала боя.',
  },
  {
    id: 'normal',
    label: 'Быстрый поиск',
    help: 'Выделите основную область данных для быстрого режима.',
  },
  {
    id: 'precise',
    label: 'Точный поиск',
    help: 'Выделите расширенную область для точного режима.',
  },
]
const RESULT_STEPS: readonly { id: RegionKind; label: string; help: string }[] = [
  {
    id: 'resultTrigger',
    label: 'Триггер результата',
    help: 'Выделите устойчивый элемент экрана, который появляется после завершения боя.',
  },
  {
    id: 'resultData',
    label: 'Данные результата',
    help: 'Выделите область результата, которая будет отправлена боту прогнозов.',
  },
]

interface SetupCommand {
  sessionId: string
  generation: number
}
type RegionHistory = Record<RegionKind, NormalizedRect[]>
type RectInputValues = Record<keyof NormalizedRect, string>

function command(view: SetupSessionView): SetupCommand {
  return { sessionId: view.sessionId, generation: view.generation }
}

function emptyHistory(): RegionHistory {
  return {
    trigger: [],
    normal: [],
    precise: [],
    resultTrigger: [],
    resultData: [],
  }
}

export function SetupApp(): React.JSX.Element {
  const [view, setView] = useState<SetupSessionView | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [activeRegion, setActiveRegion] = useState<RegionKind>('trigger')
  const [draft, setDraft] = useState<NormalizedRect | null>(null)
  const [fieldsValid, setFieldsValid] = useState(false)
  const [history, setHistory] = useState<RegionHistory>(emptyHistory)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [initialState, setInitialState] = useState<'loading' | 'error' | 'ready'>(
    'loading',
  )
  const [initialAttempt, setInitialAttempt] = useState(0)
  const [transform, setTransform] = useState<ContainTransform | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointerId: number
    start: { x: number; y: number }
  } | null>(null)
  const frameUrlRef = useRef<string | null>(null)
  const viewRef = useRef<SetupSessionView | null>(null)
  const activeRegionRef = useRef<RegionKind>('trigger')
  const busyRef = useRef(false)

  useEffect(() => {
    const lifecycle = new AbortController()

    void (async () => {
      try {
        const session = await window.crToolsSetup.getSession()
        let nextFrameUrl: string | null = null
        if (session.frameSize !== null) {
          const frame = await window.crToolsSetup.getFrame(command(session))
          if (
            frame.sessionId !== session.sessionId ||
            frame.generation !== session.generation
          )
            throw new Error('Setup frame does not belong to the active session')
          nextFrameUrl = URL.createObjectURL(
            new Blob([frame.bytes], { type: frame.mimeType }),
          )
        }
        if (lifecycle.signal.aborted) {
          if (nextFrameUrl !== null) URL.revokeObjectURL(nextFrameUrl)
          return
        }

        const initialRegion =
          session.kind === 'predictionResult' ? 'resultTrigger' : 'trigger'
        const initialDraft = session.regions[initialRegion]
        frameUrlRef.current = nextFrameUrl
        viewRef.current = session
        activeRegionRef.current = initialRegion
        setView(session)
        setFrameUrl(nextFrameUrl)
        setActiveRegion(initialRegion)
        setDraft(initialDraft)
        setFieldsValid(initialDraft !== null)
        setHistory(emptyHistory())
        setInitialState('ready')
      } catch {
        if (lifecycle.signal.aborted) return
        setInitialState('error')
      }
    })()

    return () => {
      lifecycle.abort()
      if (frameUrlRef.current !== null) {
        URL.revokeObjectURL(frameUrlRef.current)
        frameUrlRef.current = null
      }
    }
  }, [initialAttempt])

  useEffect(() => {
    const stage = stageRef.current
    const frameSize = view?.frameSize
    if (stage === null || frameSize === null || frameSize === undefined) return
    const update = (): void => {
      setTransform(
        containTransform(
          {
            width: Math.max(1, stage.clientWidth),
            height: Math.max(1, stage.clientHeight),
          },
          frameSize,
        ),
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [view?.frameSize])

  const acceptView = (next: SetupSessionView): void => {
    viewRef.current = next
    setView(next)
  }

  const beginOperation = (): boolean => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setLocalError(null)
    return true
  }

  const endOperation = (): void => {
    busyRef.current = false
    setBusy(false)
  }

  const persist = async (rect: NormalizedRect, remember = true): Promise<boolean> => {
    const current = viewRef.current
    if (current?.state !== 'SELECTING' || !beginOperation()) return false

    const region = activeRegionRef.current
    const request = command(current)
    const previous = current.regions[region]
    try {
      const next = await window.crToolsSetup.setRegion({
        ...request,
        region,
        rect,
      })
      const latest = viewRef.current
      if (
        latest?.sessionId !== request.sessionId ||
        latest.generation !== request.generation ||
        next.sessionId !== request.sessionId ||
        next.generation !== request.generation + 1
      ) {
        setLocalError('Состояние настройки изменилось. Повторно выберите область.')
        return false
      }

      acceptView(next)
      if (remember && previous !== null) {
        setHistory((items) => ({
          ...items,
          [region]: [...items[region].slice(-9), previous],
        }))
      }
      if (activeRegionRef.current === region) {
        const acceptedRect = next.regions[region]
        setDraft(acceptedRect)
        setFieldsValid(acceptedRect !== null)
      }
      return true
    } catch {
      setLocalError(
        'Не удалось подтвердить координаты. Проверьте область перед повтором.',
      )
      return false
    } finally {
      endOperation()
    }
  }

  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current
    if (stage === null || transform === null) return null
    const bounds = stage.getBoundingClientRect()
    return pointerToNormalized(
      event.clientX,
      event.clientY,
      bounds.left,
      bounds.top,
      transform,
    )
  }

  const releasePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (
      typeof event.currentTarget.hasPointerCapture === 'function' &&
      event.currentTarget.hasPointerCapture(event.pointerId) &&
      typeof event.currentTarget.releasePointerCapture === 'function'
    )
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const runCommand = async (
    invoke: (request: SetupCommand) => Promise<SetupSessionView>,
    failureMessage: string,
  ): Promise<void> => {
    const current = viewRef.current
    if (current === null || !beginOperation()) return
    const request = command(current)
    try {
      const next = await invoke(request)
      const latest = viewRef.current
      if (
        latest?.sessionId !== request.sessionId ||
        latest.generation !== request.generation ||
        next.sessionId !== request.sessionId ||
        next.generation !== request.generation + 1
      ) {
        setLocalError('Состояние настройки изменилось. Обновите текущий этап.')
        return
      }
      acceptView(next)
    } catch {
      setLocalError(failureMessage)
    } finally {
      endOperation()
    }
  }

  const analyze = (): Promise<void> =>
    runCommand(
      (request) => window.crToolsSetup.analyzeTrigger(request),
      'Анализ не завершён. Проверьте область триггера.',
    )

  const review = (): Promise<void> =>
    runCommand(
      (request) => window.crToolsSetup.review(request),
      'Для проверки нужны все области и анализ триггера.',
    )

  const commit = (): Promise<void> =>
    runCommand(
      (request) => window.crToolsSetup.commit(request),
      'Не удалось подтвердить сохранение. Сервер мог принять часть изменений; проверьте состояние перед повтором.',
    )

  const close = async (): Promise<void> => {
    const current = viewRef.current
    if (current === null || !beginOperation()) return
    try {
      await window.crToolsSetup.close(command(current))
    } catch {
      setLocalError('Не удалось закрыть настройку. Повторите попытку.')
    } finally {
      endOperation()
    }
  }

  if (initialState === 'loading')
    return (
      <main className="setup-loading" role="status" aria-live="polite">
        <span className="setup-spinner" aria-hidden="true" />
        <strong>Подготовка рабочего кадра</strong>
        <p>Загружаем источник и параметры калибровки.</p>
      </main>
    )

  if (initialState === 'error' || view === null)
    return (
      <main className="setup-loading setup-load-error" role="alert">
        <X aria-hidden="true" size={32} />
        <h1>Не удалось загрузить настройку</h1>
        <p>Не удалось получить сессию или рабочий кадр от приложения.</p>
        <button
          className="primary-button"
          type="button"
          onClick={() => {
            setInitialState('loading')
            setLocalError(null)
            setTransform(null)
            setFrameUrl(null)
            setView(null)
            viewRef.current = null
            setInitialAttempt((attempt) => attempt + 1)
          }}
        >
          Повторить
        </button>
      </main>
    )

  const steps = view.kind === 'predictionResult' ? RESULT_STEPS : STEPS
  const activeStep = steps.find((step) => step.id === activeRegion)
  if (activeStep === undefined) throw new Error('Unknown setup region')
  const redrawing = draft === null && view.regions[activeRegion] !== null
  const complete = !redrawing && steps.every((step) => view.regions[step.id] !== null)
  const canEdit = view.state === 'SELECTING'
  const canSelectRegion = canEdit || view.state === 'REVIEW'
  const pointerEditable = canEdit && !busy
  const message = localError ?? view.error?.message ?? null
  const activeHistory = history[activeRegion]
  const failed = view.state === 'FAILED' || frameUrl === null || view.frameSize === null
  const frameSizeLabel =
    view.frameSize === null ? '' : `${view.frameSize.width} × ${view.frameSize.height} px`

  return (
    <main className="setup-workspace" data-state={view.state} aria-busy={busy}>
      <header className="setup-header">
        <div>
          <span className="eyebrow">
            {view.kind === 'predictionResult'
              ? 'PREDICTION RESULT'
              : 'CAPTURE CALIBRATION'}
          </span>
          <h1>
            {view.kind === 'predictionResult'
              ? 'Зоны результата боя'
              : 'Области распознавания'}
          </h1>
          <p>{view.source.label}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Отменить и закрыть"
          disabled={busy}
          onClick={() => void close()}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <ol className="setup-steps" aria-label="Этапы настройки">
        {steps.map((step, index) => {
          const stepComplete = view.regions[step.id] !== null
          const stepSelected = step.id === activeRegion
          const stepCurrent = canEdit && stepSelected
          return (
            <li key={step.id} data-active={stepSelected} data-complete={stepComplete}>
              <span aria-hidden="true">
                {stepComplete ? <Check size={14} /> : index + 1}
              </span>
              <button
                type="button"
                aria-current={stepCurrent ? 'step' : undefined}
                aria-label={`${step.label}. ${
                  stepComplete ? 'Область задана.' : 'Область не задана.'
                }${
                  stepCurrent
                    ? ' Текущий этап.'
                    : stepSelected
                      ? ' Выбрана для просмотра.'
                      : ''
                }`}
                disabled={busy || !canSelectRegion}
                onClick={() => {
                  const currentState = viewRef.current?.state
                  if (
                    busyRef.current ||
                    (currentState !== 'SELECTING' && currentState !== 'REVIEW')
                  )
                    return
                  activeRegionRef.current = step.id
                  setActiveRegion(step.id)
                  setDraft(view.regions[step.id])
                  setFieldsValid(view.regions[step.id] !== null)
                }}
              >
                {step.label}
              </button>
            </li>
          )
        })}
        <li
          data-active={view.state === 'REVIEW'}
          data-complete={view.state === 'COMMITTED'}
        >
          <span aria-hidden="true">
            {view.state === 'COMMITTED' ? <Check size={14} /> : steps.length + 1}
          </span>
          <button
            type="button"
            aria-current={view.state === 'REVIEW' ? 'step' : undefined}
            aria-label={`Проверка. ${
              view.triggerProfile === null ? 'Анализ триггера не выполнен.' : 'Доступна.'
            }${view.state === 'REVIEW' ? ' Текущий этап.' : ''}`}
            disabled={busy || !canEdit || view.triggerProfile === null}
            onClick={() => void review()}
          >
            Проверка
          </button>
        </li>
      </ol>
      {message !== null && (
        <div className="inline-alert setup-alert" role="alert">
          {message}
        </div>
      )}
      {view.state === 'COMMITTED' ? (
        <section className="setup-complete" data-tone="success">
          <Check aria-hidden="true" size={32} />
          <h2>
            {view.kind === 'predictionResult'
              ? 'Зоны результата настроены'
              : 'Захват настроен'}
          </h2>
          <p>Приложение подтвердило сохранение конфигурации.</p>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void close()}
          >
            Закрыть
          </button>
        </section>
      ) : failed ? (
        <section className="setup-complete" data-tone="danger">
          <X aria-hidden="true" size={32} />
          <h2>
            {view.state === 'FAILED'
              ? 'Настройка завершилась с ошибкой'
              : 'Кадр недоступен'}
          </h2>
          <p>
            {view.error?.message ??
              localError ??
              'Приложение не смогло получить рабочий кадр.'}
          </p>
          <p className="setup-state-note">
            Итоговое состояние удалённой конфигурации не подтверждено. Часть изменений
            могла быть принята сервером.
          </p>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => void close()}
          >
            Закрыть
          </button>
        </section>
      ) : (
        <div className="setup-grid">
          <section className="frame-panel" aria-label="Рабочий кадр">
            <header className="frame-toolbar">
              <div>
                <span>РАБОЧИЙ КАДР</span>
                <strong>{frameSizeLabel}</strong>
              </div>
              <span className="frame-status" data-busy={busy}>
                <i aria-hidden="true" />
                {busy
                  ? 'Обработка'
                  : canEdit
                    ? 'Выделение области'
                    : 'Проверка конфигурации'}
              </span>
            </header>
            <div
              className="capture-stage"
              data-editable={pointerEditable}
              ref={stageRef}
              role="group"
              aria-label="Выделение области на рабочем кадре"
              aria-describedby="capture-stage-help"
              onPointerDown={(event) => {
                if (!pointerEditable || busyRef.current) return
                const next = point(event)
                if (next !== null) {
                  drag.current = { pointerId: event.pointerId, start: next }
                  if (typeof event.currentTarget.setPointerCapture === 'function')
                    event.currentTarget.setPointerCapture(event.pointerId)
                }
              }}
              onPointerMove={(event) => {
                const currentDrag = drag.current
                if (
                  !pointerEditable ||
                  busyRef.current ||
                  currentDrag?.pointerId !== event.pointerId
                )
                  return
                const next = point(event)
                if (next !== null) {
                  const nextDraft = rectFromPoints(currentDrag.start, next)
                  setDraft(nextDraft)
                  setFieldsValid(nextDraft !== null)
                }
              }}
              onPointerUp={(event) => {
                const currentDrag = drag.current
                if (currentDrag?.pointerId === event.pointerId) {
                  if (!busyRef.current) {
                    const next = point(event)
                    const nextDraft =
                      next === null ? null : rectFromPoints(currentDrag.start, next)
                    if (nextDraft !== null) {
                      setDraft(nextDraft)
                      setFieldsValid(true)
                    }
                  }
                  drag.current = null
                }
                releasePointer(event)
              }}
              onPointerCancel={(event) => {
                if (drag.current?.pointerId === event.pointerId) {
                  drag.current = null
                  const saved = viewRef.current?.regions[activeRegionRef.current] ?? null
                  setDraft(saved)
                  setFieldsValid(saved !== null)
                }
                releasePointer(event)
              }}
              onLostPointerCapture={(event) => {
                if (drag.current?.pointerId === event.pointerId) drag.current = null
              }}
            >
              {transform !== null && (
                <div
                  className="image-surface"
                  style={{
                    left: transform.x,
                    top: transform.y,
                    width: transform.width,
                    height: transform.height,
                  }}
                >
                  <img src={frameUrl} alt="Кадр выбранного источника" draggable={false} />
                  {steps.map((step) => {
                    const rect = step.id === activeRegion ? draft : view.regions[step.id]
                    return rect === null ? null : (
                      <div
                        className={`region-box region-${step.id}`}
                        key={step.id}
                        data-active={step.id === activeRegion}
                        style={{
                          left: `${rect.x * 100}%`,
                          top: `${rect.y * 100}%`,
                          width: `${rect.width * 100}%`,
                          height: `${rect.height * 100}%`,
                        }}
                      >
                        <span>{step.label}</span>
                        <i className="region-handle" aria-hidden="true" />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
          <aside className="region-panel">
            <span className="eyebrow">ТЕКУЩИЙ ЭТАП</span>
            <h2>{activeStep.label}</h2>
            <p id="capture-stage-help">
              {activeStep.help} Нарисуйте область указателем или введите координаты с
              клавиатуры.
            </p>
            <RectFields
              key={activeRegion}
              rect={draft}
              disabled={!canEdit || busy}
              onChange={setDraft}
              onValidityChange={setFieldsValid}
            />
            <div className="region-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={activeHistory.length === 0 || busy || !canEdit}
                onClick={() => {
                  const region = activeRegionRef.current
                  const previous = history[region].at(-1)
                  if (previous === undefined) return
                  void persist(previous, false).then((accepted) => {
                    if (!accepted) return
                    setHistory((items) => ({
                      ...items,
                      [region]: items[region].slice(0, -1),
                    }))
                  })
                }}
              >
                <ArrowLeft aria-hidden="true" size={15} />
                Отменить
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={draft === null || busy || !canEdit}
                onClick={() => {
                  if (busyRef.current) return
                  setDraft(null)
                  setFieldsValid(false)
                }}
              >
                <RotateCcw aria-hidden="true" size={15} />
                Перерисовать
              </button>
            </div>
            <button
              className="primary-button region-save"
              type="button"
              disabled={draft === null || !fieldsValid || busy || !canEdit}
              onClick={() => {
                if (draft !== null && fieldsValid) void persist(draft)
              }}
            >
              Применить координаты
            </button>
            {complete && view.triggerProfile === null && (
              <button
                className="primary-button region-save"
                type="button"
                disabled={busy || !canEdit}
                onClick={() => void analyze()}
              >
                <ScanLine aria-hidden="true" size={16} />
                {busy ? 'Анализ...' : 'Анализировать триггер'}
              </button>
            )}
            {view.triggerProfile !== null && view.state !== 'REVIEW' && (
              <button
                className="primary-button region-save"
                type="button"
                disabled={busy || !canEdit}
                onClick={() => void review()}
              >
                Перейти к проверке
              </button>
            )}
            {view.state === 'REVIEW' && (
              <button
                className="primary-button region-save"
                type="button"
                disabled={busy}
                onClick={() => void commit()}
              >
                {busy ? 'Сохранение...' : 'Сохранить конфигурацию'}
              </button>
            )}
            {view.triggerProfile !== null && (
              <details className="diagnostics">
                <summary>Диагностика профиля</summary>
                <dl>
                  <div>
                    <dt>Версия</dt>
                    <dd>{view.triggerProfile.analyzer.version}</dd>
                  </div>
                  <div>
                    <dt>Контрольный хэш</dt>
                    <dd>{view.triggerProfile.ahash64}</dd>
                  </div>
                  <div>
                    <dt>Ключевые точки</dt>
                    <dd>{view.triggerProfile.keypointsCount}</dd>
                  </div>
                </dl>
              </details>
            )}
          </aside>
        </div>
      )}
    </main>
  )
}

function inputValues(rect: NormalizedRect | null): RectInputValues {
  if (rect === null) return { x: '', y: '', width: '', height: '' }
  return {
    x: String(Number((rect.x * 100).toFixed(2))),
    y: String(Number((rect.y * 100).toFixed(2))),
    width: String(Number((rect.width * 100).toFixed(2))),
    height: String(Number((rect.height * 100).toFixed(2))),
  }
}

function parseRect(values: RectInputValues): NormalizedRect | null {
  if (Object.values(values).some((value) => value.trim() === '')) return null
  const next = {
    x: Number(values.x) / 100,
    y: Number(values.y) / 100,
    width: Number(values.width) / 100,
    height: Number(values.height) / 100,
  }
  return Number.isFinite(next.x) &&
    Number.isFinite(next.y) &&
    Number.isFinite(next.width) &&
    Number.isFinite(next.height) &&
    next.width > 0 &&
    next.height > 0 &&
    next.x >= 0 &&
    next.y >= 0 &&
    next.x + next.width <= 1 &&
    next.y + next.height <= 1
    ? next
    : null
}

function RectFields({
  rect,
  disabled,
  onChange,
  onValidityChange,
}: {
  rect: NormalizedRect | null
  disabled: boolean
  onChange: (rect: NormalizedRect) => void
  onValidityChange: (valid: boolean) => void
}): React.JSX.Element {
  const [lastRect, setLastRect] = useState(rect)
  const [values, setValues] = useState<RectInputValues>(() => inputValues(rect))
  if (rect !== lastRect) {
    setLastRect(rect)
    setValues(inputValues(rect))
  }

  const update = (key: keyof NormalizedRect, raw: string): void => {
    const nextValues = { ...values, [key]: raw }
    const nextRect = parseRect(nextValues)
    setValues(nextValues)
    onValidityChange(nextRect !== null)
    if (nextRect !== null) onChange(nextRect)
  }

  return (
    <fieldset className="rect-fields" disabled={disabled}>
      <legend>Координаты, %</legend>
      <p className="rect-fields-hint" id="rect-fields-hint">
        Числовая альтернатива выделению указателем. Заполните все четыре поля.
      </p>
      {(['x', 'y', 'width', 'height'] as const).map((key) => (
        <label key={key}>
          <span>{key.toUpperCase()}</span>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            inputMode="decimal"
            value={values[key]}
            aria-describedby="rect-fields-hint"
            onChange={(event) => update(key, event.target.value)}
          />
        </label>
      ))}
    </fieldset>
  )
}
