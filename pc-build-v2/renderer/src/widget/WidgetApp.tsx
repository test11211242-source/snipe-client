import { useEffect, useEffectEvent, useRef, useState } from 'react'

import {
  WIDGET_MAX_HEIGHT,
  WIDGET_MIN_HEIGHT,
  type WidgetSettingsPatch,
  type WidgetView,
} from '../../../shared/models/widget'
import { REPROCESSED_LABEL } from '../features/opponent/labels'
import { OverlayCard } from './OverlayCard'
import { selectOverlayModel } from './overlayModel'

const OPACITY_STEP = 5
const MIN_OPACITY_PERCENT = 55
const MAX_OPACITY_PERCENT = 100
/** Content-height reports wait for layout (cards, scale) to settle. */
const HEIGHT_REPORT_DELAY_MS = 120

function sameWidgetView(left: WidgetView, right: WidgetView): boolean {
  const leftBounds = left.settings.bounds
  const rightBounds = right.settings.bounds
  return (
    left.result === right.result &&
    left.visible === right.visible &&
    left.scale === right.scale &&
    left.settings.autoOpen === right.settings.autoOpen &&
    left.settings.alwaysOnTop === right.settings.alwaysOnTop &&
    left.settings.locked === right.settings.locked &&
    left.settings.opacity === right.settings.opacity &&
    left.settings.displayMode === right.settings.displayMode &&
    left.settings.compactMode === right.settings.compactMode &&
    left.monitorState === right.monitorState &&
    left.monitorError?.code === right.monitorError?.code &&
    left.runIntent === right.runIntent &&
    left.sourceMinimized === right.sourceMinimized &&
    left.search?.attemptId === right.search?.attemptId &&
    left.search?.phase === right.search?.phase &&
    left.search?.searchedNickname === right.search?.searchedNickname &&
    leftBounds.x === rightBounds.x &&
    leftBounds.y === rightBounds.y &&
    leftBounds.width === rightBounds.width &&
    leftBounds.height === rightBounds.height
  )
}

interface MutationOptions {
  /** Size reports are not user settings: no pending state, no error notice. */
  silent?: boolean
}

export function WidgetApp(): React.JSX.Element {
  const [view, setView] = useState<WidgetView | null>(null)
  const [deckSelection, setDeckSelection] = useState({ resultId: '', index: 0 })
  const [failed, setFailed] = useState(false)
  const [pendingMutations, setPendingMutations] = useState(0)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [opacityDraft, setOpacityDraft] = useState(96)
  const [opacityDirty, setOpacityDirty] = useState(false)
  const shellRef = useRef<HTMLElement | null>(null)
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingMutationsRef = useRef(0)
  const opacityDraftRef = useRef(96)
  const opacityDirtyRef = useRef(false)
  const mountedRef = useRef(true)
  const reportedHeightRef = useRef<number | null>(null)

  const saving = pendingMutations > 0
  const loaded = view !== null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    void window.crToolsWidget.rendererReady().catch(() => undefined)
  }, [])

  useEffect(() => {
    return window.crToolsWidget.onViewChanged((nextView) => {
      setView((current) =>
        pendingMutationsRef.current > 0 && current !== null
          ? { ...nextView, settings: current.settings }
          : nextView,
      )
      setFailed(false)
    })
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    let restartPending = false
    let timer: number | undefined

    const schedule = (delay: number): void => {
      if (!active) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), delay)
    }

    const restart = (): void => {
      if (inFlight) {
        restartPending = true
        return
      }
      schedule(document.hidden ? 5_000 : 0)
    }

    const load = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const loadedView = await window.crToolsWidget.getView()
        if (active) {
          setView((current) =>
            pendingMutationsRef.current > 0 && current !== null
              ? { ...loadedView, settings: current.settings }
              : current !== null && sameWidgetView(current, loadedView)
                ? current
                : loadedView,
          )
          setFailed(false)
        }
      } catch {
        if (active) setFailed(true)
      }
      inFlight = false
      if (!active) return
      if (restartPending) {
        restartPending = false
        restart()
        return
      }
      schedule(document.hidden ? 30_000 : 10_000)
    }

    const onVisibilityChange = (): void => restart()
    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule(0)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const enqueueSettings = (
    patch: WidgetSettingsPatch,
    { silent = false }: MutationOptions = {},
  ): Promise<boolean> => {
    if (!silent) {
      pendingMutationsRef.current += 1
      setPendingMutations((current) => current + 1)
      setMutationError(null)
    }

    const mutation = mutationQueueRef.current.then(async () => {
      const settings = await window.crToolsWidget.updateSettings(patch)
      if (mountedRef.current) {
        setView((current) => (current === null ? current : { ...current, settings }))
      }
    })
    const result = mutation.then(
      () => true,
      () => {
        if (mountedRef.current && !silent)
          setMutationError('Не удалось сохранить настройку.')
        return false
      },
    )
    mutationQueueRef.current = result.then(() => undefined)
    void result.then(() => {
      if (silent) return
      pendingMutationsRef.current -= 1
      if (mountedRef.current) setPendingMutations((current) => Math.max(0, current - 1))
    })
    return result
  }

  const enqueueSettingsEvent = useEffectEvent(enqueueSettings)

  // Window height follows the content. The shell has no fixed height, so its measured
  // height does not depend on the window height: a report never triggers another one.
  useEffect(() => {
    const shell = shellRef.current
    if (!loaded || shell === null || typeof ResizeObserver === 'undefined') return
    reportedHeightRef.current = null
    let timer: number | undefined
    const report = (): void => {
      const height = Math.min(
        WIDGET_MAX_HEIGHT,
        Math.max(WIDGET_MIN_HEIGHT, Math.ceil(shell.getBoundingClientRect().height)),
      )
      if (reportedHeightRef.current === height) return
      reportedHeightRef.current = height
      void enqueueSettingsEvent({ contentHeight: height }, { silent: true }).then(
        (ok) => {
          if (!ok && reportedHeightRef.current === height) {
            reportedHeightRef.current = null
            if (mountedRef.current) timer = window.setTimeout(report, 1_000)
          }
        },
      )
    }
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(report, HEIGHT_REPORT_DELAY_MS)
    })
    observer.observe(shell)
    timer = window.setTimeout(report, HEIGHT_REPORT_DELAY_MS)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [loaded])

  useEffect(() => {
    if (view === null || opacityDirtyRef.current) return
    const nextOpacity = Math.round(view.settings.opacity * 100)
    opacityDraftRef.current = nextOpacity
    setOpacityDraft(nextOpacity)
  }, [view])

  useEffect(() => {
    if (!opacityDirty) return
    let active = true
    const timer = window.setTimeout(() => {
      void enqueueSettingsEvent({ opacity: opacityDraft / 100 }).then((updated) => {
        if (!active) return
        opacityDirtyRef.current = false
        setOpacityDirty(false)
        if (!updated) setMutationError('Не удалось сохранить прозрачность.')
      })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [opacityDirty, opacityDraft])

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      void window.crToolsWidget.hide()
      return
    }
  })

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    if (!event.ctrlKey || event.deltaY === 0 || view === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const current = opacityDirtyRef.current
      ? opacityDraftRef.current
      : Math.round(view.settings.opacity * 100)
    const next = Math.min(
      MAX_OPACITY_PERCENT,
      Math.max(
        MIN_OPACITY_PERCENT,
        current + (event.deltaY < 0 ? OPACITY_STEP : -OPACITY_STEP),
      ),
    )
    opacityDirtyRef.current = true
    opacityDraftRef.current = next
    setOpacityDraft(next)
    setOpacityDirty(true)
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => handleKeyDown(event)
    const onWheel = (event: WheelEvent): void => handleWheel(event)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('wheel', onWheel, true)
    }
  }, [])

  if (view === null) {
    return (
      <main aria-busy={!failed} aria-live="polite" ref={shellRef}>
        <p className="sr-only">
          {failed
            ? 'Оверлей временно недоступен. Повторная проверка выполняется.'
            : 'Загрузка…'}
        </p>
      </main>
    )
  }

  const model = selectOverlayModel(view)
  const resultId = view.result?.id ?? null
  const decks = model.body.kind === 'found' ? model.body.result.decks.length : 0
  const requested = deckSelection.resultId === resultId ? deckSelection.index : 0
  const deckIndex = Math.min(requested, Math.max(0, decks - 1))
  const notice =
    mutationError ?? (view.result?.reprocessed === true ? REPROCESSED_LABEL : null)

  return (
    <OverlayCard
      compact={view.settings.compactMode}
      controls={{
        disabled: saving,
        onCompact: () =>
          void enqueueSettings({ compactMode: !view.settings.compactMode }),
        onHide: () => void window.crToolsWidget.hide(),
        onLock: () => void enqueueSettings({ locked: !view.settings.locked }),
        onPin: () => void enqueueSettings({ alwaysOnTop: !view.settings.alwaysOnTop }),
      }}
      deckIndex={deckIndex}
      model={model}
      notice={notice}
      onDeck={(index) => setDeckSelection({ resultId: resultId ?? '', index })}
      shellRef={shellRef}
      view={view}
    />
  )
}
