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

function command(view: SetupSessionView) {
  return { sessionId: view.sessionId, generation: view.generation }
}

export function SetupApp(): React.JSX.Element {
  const [view, setView] = useState<SetupSessionView | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [activeRegion, setActiveRegion] = useState<RegionKind>('trigger')
  const [draft, setDraft] = useState<NormalizedRect | null>(null)
  const [history, setHistory] = useState<NormalizedRect[]>([])
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [transform, setTransform] = useState<ContainTransform | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const frameUrlRef = useRef<string | null>(null)

  useEffect(() => {
    const lifecycle = new AbortController()
    void window.crToolsSetup
      .getSession()
      .then((session) => {
        if (lifecycle.signal.aborted) return
        setView(session)
        if (session.kind === 'predictionResult') setActiveRegion('resultTrigger')
        if (session.frameSize === null) return
        return window.crToolsSetup.getFrame(command(session)).then((frame) => {
          if (lifecycle.signal.aborted) return
          const url = URL.createObjectURL(
            new Blob([frame.bytes], { type: frame.mimeType }),
          )
          frameUrlRef.current = url
          setFrameUrl(url)
          setDraft(
            session.kind === 'predictionResult'
              ? session.regions.resultTrigger
              : session.regions.trigger,
          )
        })
      })
      .catch(() => setLocalError('Сессия настройки недоступна.'))
    return () => {
      lifecycle.abort()
      if (frameUrlRef.current !== null) URL.revokeObjectURL(frameUrlRef.current)
    }
  }, [])

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

  const persist = async (rect: NormalizedRect, remember = true): Promise<void> => {
    if (view === null) return
    setBusy(true)
    setLocalError(null)
    try {
      const previous = view.regions[activeRegion]
      if (remember && previous !== null)
        setHistory((items) => [...items.slice(-9), previous])
      const next = await window.crToolsSetup.setRegion({
        ...command(view),
        region: activeRegion,
        rect,
      })
      setView(next)
      setDraft(rect)
    } catch {
      setLocalError('Не удалось сохранить область. Повторите выделение.')
    } finally {
      setBusy(false)
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

  const analyze = async (): Promise<void> => {
    if (view === null) return
    setBusy(true)
    setLocalError(null)
    try {
      setView(await window.crToolsSetup.analyzeTrigger(command(view)))
    } catch {
      setLocalError('Анализ не завершён. Проверьте область триггера.')
    } finally {
      setBusy(false)
    }
  }

  const review = async (): Promise<void> => {
    if (view === null) return
    setBusy(true)
    try {
      setView(await window.crToolsSetup.review(command(view)))
    } catch {
      setLocalError('Для проверки нужны все три области и анализ триггера.')
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    if (view === null) return
    setBusy(true)
    try {
      setView(await window.crToolsSetup.commit(command(view)))
    } catch {
      setLocalError('Настройка не сохранена. Активная конфигурация не изменилась.')
    } finally {
      setBusy(false)
    }
  }

  const close = async (): Promise<void> => {
    if (view === null) return
    await window.crToolsSetup.close(command(view)).catch(() => undefined)
  }

  if (view === null)
    return (
      <main className="setup-loading" role="status" aria-live="polite">
        <span className="setup-spinner" aria-hidden="true" />
        <strong>Подготовка рабочего кадра</strong>
        <p>Загружаем источник и параметры калибровки.</p>
      </main>
    )
  const steps = view.kind === 'predictionResult' ? RESULT_STEPS : STEPS
  const activeStep = steps.find((step) => step.id === activeRegion)
  if (activeStep === undefined) throw new Error('Unknown setup region')
  const redrawing = draft === null && view.regions[activeRegion] !== null
  const complete = !redrawing && steps.every((step) => view.regions[step.id] !== null)
  const canEdit = view.state === 'SELECTING'
  const message = localError ?? view.error?.message ?? null

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
          onClick={() => void close()}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <ol className="setup-steps" aria-label="Этапы настройки">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-active={step.id === activeRegion}
            data-complete={view.regions[step.id] !== null}
          >
            <span>
              {view.regions[step.id] === null ? index + 1 : <Check size={14} />}
            </span>
            <button
              type="button"
              onClick={() => {
                setActiveRegion(step.id)
                setDraft(view.regions[step.id])
              }}
            >
              {step.label}
            </button>
          </li>
        ))}
        <li data-active={view.state === 'REVIEW'}>
          <span>{steps.length + 1}</span>
          <button
            type="button"
            disabled={view.triggerProfile === null}
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
          <p>Конфигурация сохранена локально и на сервере.</p>
          <button className="primary-button" type="button" onClick={() => void close()}>
            Закрыть
          </button>
        </section>
      ) : view.state === 'FAILED' || frameUrl === null || view.frameSize === null ? (
        <section className="setup-complete" data-tone="danger">
          <X aria-hidden="true" size={32} />
          <h2>Кадр недоступен</h2>
          <p>Настройка не изменила активную конфигурацию.</p>
          <button className="secondary-button" type="button" onClick={() => void close()}>
            Закрыть
          </button>
        </section>
      ) : (
        <div className="setup-grid">
          <section className="frame-panel" aria-label="Рабочий кадр">
            <header className="frame-toolbar">
              <div>
                <span>РАБОЧИЙ КАДР</span>
                <strong>
                  {view.frameSize.width} × {view.frameSize.height} px
                </strong>
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
              data-editable={canEdit}
              ref={stageRef}
              onPointerDown={(event) => {
                if (!canEdit) return
                const next = point(event)
                if (next !== null) {
                  dragStart.current = next
                  event.currentTarget.setPointerCapture(event.pointerId)
                }
              }}
              onPointerMove={(event) => {
                const next = point(event)
                if (next !== null && dragStart.current !== null)
                  setDraft(rectFromPoints(dragStart.current, next))
              }}
              onPointerUp={(event) => {
                const next = point(event)
                const rect =
                  next === null || dragStart.current === null
                    ? null
                    : rectFromPoints(dragStart.current, next)
                dragStart.current = null
                if (rect !== null) void persist(rect)
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
                        <i className="region-handle" />
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
            <p>{activeStep.help}</p>
            <RectFields rect={draft} onChange={setDraft} />
            <div className="region-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={history.length === 0 || busy}
                onClick={() => {
                  const previous = history.at(-1)
                  if (previous !== undefined) {
                    setHistory((items) => items.slice(0, -1))
                    void persist(previous, false)
                  }
                }}
              >
                <ArrowLeft size={15} />
                Отменить
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={draft === null || busy || !canEdit}
                onClick={() => {
                  setDraft(null)
                }}
              >
                <RotateCcw size={15} />
                Перерисовать
              </button>
            </div>
            <button
              className="primary-button region-save"
              type="button"
              disabled={draft === null || busy || !canEdit}
              onClick={() => {
                if (draft !== null) void persist(draft)
              }}
            >
              Применить координаты
            </button>
            {complete && view.triggerProfile === null && (
              <button
                className="primary-button region-save"
                type="button"
                disabled={busy}
                onClick={() => void analyze()}
              >
                <ScanLine size={16} />
                {busy ? 'Анализ...' : 'Анализировать триггер'}
              </button>
            )}
            {view.triggerProfile !== null && view.state !== 'REVIEW' && (
              <button
                className="primary-button region-save"
                type="button"
                disabled={busy}
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

function RectFields({
  rect,
  onChange,
}: {
  rect: NormalizedRect | null
  onChange: (rect: NormalizedRect | null) => void
}): React.JSX.Element {
  const values = rect ?? { x: 0, y: 0, width: 0.1, height: 0.1 }
  const update = (key: keyof NormalizedRect, raw: string): void => {
    const value = Number(raw) / 100
    const next = { ...values, [key]: value }
    onChange(
      next.width > 0 &&
        next.height > 0 &&
        next.x >= 0 &&
        next.y >= 0 &&
        next.x + next.width <= 1 &&
        next.y + next.height <= 1
        ? next
        : null,
    )
  }
  return (
    <fieldset className="rect-fields">
      <legend>Координаты, %</legend>
      {(['x', 'y', 'width', 'height'] as const).map((key) => (
        <label key={key}>
          <span>{key.toUpperCase()}</span>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={Number((values[key] * 100).toFixed(2))}
            onChange={(event) => update(key, event.target.value)}
          />
        </label>
      ))}
    </fieldset>
  )
}
