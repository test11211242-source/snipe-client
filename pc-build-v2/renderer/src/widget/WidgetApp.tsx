import { GripVertical, LayoutGrid, Lock, Pin, Unlock, X } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

import type { WidgetSettingsPatch, WidgetView } from '../../../shared/models/widget'
import ratingIcon from './assets/rating.png'

const OPACITY_STEP = 5
const MIN_OPACITY_PERCENT = 55
const MAX_OPACITY_PERCENT = 100
const SAVE_FEEDBACK_DURATION_MS = 2_500
const CARD_ASSET_RETRY_DELAYS_MS = [250, 750, 1_500] as const
const CARD_ASSET_MAX_ATTEMPTS = CARD_ASSET_RETRY_DELAYS_MS.length + 1

function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted
}

function sameWidgetView(left: WidgetView, right: WidgetView): boolean {
  const leftBounds = left.settings.bounds
  const rightBounds = right.settings.bounds
  return (
    left.result?.id === right.result?.id &&
    left.visible === right.visible &&
    left.settings.autoOpen === right.settings.autoOpen &&
    left.settings.alwaysOnTop === right.settings.alwaysOnTop &&
    left.settings.locked === right.settings.locked &&
    left.settings.opacity === right.settings.opacity &&
    left.settings.displayMode === right.settings.displayMode &&
    leftBounds.x === rightBounds.x &&
    leftBounds.y === rightBounds.y &&
    leftBounds.width === rightBounds.width &&
    leftBounds.height === rightBounds.height
  )
}

export function WidgetApp(): React.JSX.Element {
  const [view, setView] = useState<WidgetView | null>(null)
  const [deckSelection, setDeckSelection] = useState({ resultId: '', index: 0 })
  const [failed, setFailed] = useState(false)
  const [pendingMutations, setPendingMutations] = useState(0)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [opacityDraft, setOpacityDraft] = useState(96)
  const [opacityDirty, setOpacityDirty] = useState(false)
  const deckTabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingMutationsRef = useRef(0)
  const opacityDraftRef = useRef(96)
  const opacityDirtyRef = useRef(false)
  const mountedRef = useRef(true)

  const saving = pendingMutations > 0

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
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), SAVE_FEEDBACK_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [saved])

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

  const enqueueSettings = (patch: WidgetSettingsPatch): Promise<boolean> => {
    pendingMutationsRef.current += 1
    setPendingMutations((current) => current + 1)
    setMutationError(null)
    setSaved(false)

    const mutation = mutationQueueRef.current.then(async () => {
      const settings = await window.crToolsWidget.updateSettings(patch)
      if (mountedRef.current) {
        setView((current) => (current === null ? current : { ...current, settings }))
      }
    })
    const result = mutation.then(
      () => true,
      () => {
        if (mountedRef.current) setMutationError('Не удалось сохранить настройку.')
        return false
      },
    )
    mutationQueueRef.current = result.then(() => undefined)
    void result.then((updated) => {
      pendingMutationsRef.current -= 1
      if (!mountedRef.current) return
      setPendingMutations((current) => Math.max(0, current - 1))
      if (updated && pendingMutationsRef.current === 0) setSaved(true)
    })
    return result
  }

  const enqueueSettingsEvent = useEffectEvent(enqueueSettings)

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
    const settings = view?.settings
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      void window.crToolsWidget.hide()
      return
    }
    if (settings === undefined || !event.ctrlKey || pendingMutationsRef.current > 0) {
      return
    }

    const key = event.key.toLowerCase()
    let patch: WidgetSettingsPatch | null = null
    if (key === 'p') patch = { alwaysOnTop: !settings.alwaysOnTop }
    if (key === 'l') patch = { locked: !settings.locked }
    if (key === 'm') {
      patch = { displayMode: settings.displayMode === 'deck' ? 'detailed' : 'deck' }
    }
    if (patch === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void enqueueSettingsEvent(patch)
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
    setSaved(false)
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

  const result = view?.result ?? null
  const found = result?.kind === 'player_found' ? result : null
  const resultId = result?.id ?? null
  const requestedDeck = deckSelection.resultId === resultId ? deckSelection.index : 0
  const selectedDeck = Math.min(
    requestedDeck,
    Math.max(0, (found?.decks.length ?? 1) - 1),
  )
  const deck = found?.decks[selectedDeck] ?? null
  const compactMode = view?.settings.displayMode === 'deck'
  const playerName =
    found?.player.name ?? result?.searchedNickname ?? 'Ожидание соперника'
  const feedback = saving
    ? 'Сохраняем настройку...'
    : (mutationError ?? (saved ? 'Настройка сохранена' : ''))

  return (
    <main
      className="widget-shell"
      data-locked={view?.settings.locked ?? false}
      data-mode={compactMode ? 'compact' : 'full'}
      data-pinned={view?.settings.alwaysOnTop ?? false}
    >
      <header className="widget-header">
        <span
          className="widget-drag-handle"
          title={
            view?.settings.locked === true ? 'Позиция заблокирована' : 'Перетащить виджет'
          }
        >
          <GripVertical aria-hidden="true" size={16} />
        </span>
        <div className="player-info">
          <h1 title={playerName}>{playerName}</h1>
          {found?.player.rating !== null && found?.player.rating !== undefined && (
            <span className="player-rating" aria-label={`Рейтинг ${found.player.rating}`}>
              <img src={ratingIcon} className="rating-icon" aria-hidden="true" alt="" />
              {found.player.rating.toLocaleString('ru-RU')}
            </span>
          )}
        </div>

        <div className="widget-controls" aria-label="Управление виджетом">
          <ControlButton
            active={view?.settings.alwaysOnTop ?? false}
            label={
              view?.settings.alwaysOnTop === true
                ? 'Открепить от переднего плана'
                : 'Закрепить поверх окон'
            }
            disabled={view === null || saving}
            onClick={() => {
              if (view !== null) {
                void enqueueSettings({ alwaysOnTop: !view.settings.alwaysOnTop })
              }
            }}
          >
            <Pin aria-hidden="true" size={15} />
          </ControlButton>
          <ControlButton
            active={view?.settings.locked ?? false}
            label={
              view?.settings.locked === true
                ? 'Разблокировать позицию'
                : 'Заблокировать позицию'
            }
            disabled={view === null || saving}
            onClick={() => {
              if (view !== null) void enqueueSettings({ locked: !view.settings.locked })
            }}
          >
            {view?.settings.locked === true ? (
              <Lock aria-hidden="true" size={15} />
            ) : (
              <Unlock aria-hidden="true" size={15} />
            )}
          </ControlButton>
          <ControlButton
            active={compactMode}
            label={compactMode ? 'Полный вид' : 'Компактный вид'}
            disabled={view === null || saving}
            onClick={() => {
              if (view !== null) {
                void enqueueSettings({
                  displayMode: view.settings.displayMode === 'deck' ? 'detailed' : 'deck',
                })
              }
            }}
          >
            <LayoutGrid aria-hidden="true" size={15} />
          </ControlButton>
          <button
            className="widget-control close-button"
            type="button"
            aria-label="Скрыть виджет"
            title="Скрыть виджет"
            onClick={() => void window.crToolsWidget.hide()}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      <div className="widget-content">
        {failed && view === null ? (
          <EmptyState
            tone="danger"
            title="Виджет временно недоступен"
            detail="Повторная проверка выполняется."
          />
        ) : view === null ? (
          <EmptyState
            loading
            title="Загрузка результата"
            detail="Подключение к локальному монитору."
          />
        ) : found === null ? (
          <EmptyResult result={result} />
        ) : found.decks.length === 0 ? (
          <EmptyState
            title="Колоды не найдены"
            detail="Профиль игрока получен без колод."
          />
        ) : (
          <section
            className="deck-stage"
            aria-label={`Колоды игрока ${found.player.name}`}
          >
            <div
              className="card-grid"
              id={`deck-panel-${selectedDeck}`}
              role={found.decks.length > 1 ? 'tabpanel' : 'group'}
              aria-label={found.decks.length === 1 ? 'Карты колоды' : undefined}
              aria-labelledby={
                found.decks.length > 1 ? `deck-tab-${selectedDeck}` : undefined
              }
            >
              {deck !== null && (
                <DeckCards
                  key={`${found.id}-${selectedDeck}`}
                  resultId={found.id}
                  deckIndex={selectedDeck}
                  cards={deck.cards}
                />
              )}
            </div>
            {found.decks.length > 1 && (
              <div className="deck-switcher" role="tablist" aria-label="Выбор колоды">
                {found.decks.map((item, index) => {
                  const label = item.label ?? `Колода ${index + 1}`
                  return (
                    <button
                      key={`${item.label ?? 'deck'}-${index}`}
                      type="button"
                      role="tab"
                      id={`deck-tab-${index}`}
                      aria-controls={`deck-panel-${index}`}
                      aria-label={`Колода ${index + 1}: ${label}`}
                      aria-selected={selectedDeck === index}
                      tabIndex={selectedDeck === index ? 0 : -1}
                      onClick={() => setDeckSelection({ resultId: found.id, index })}
                      onKeyDown={(event) => {
                        let nextIndex: number | null = null
                        if (event.key === 'ArrowRight') {
                          nextIndex = (index + 1) % found.decks.length
                        }
                        if (event.key === 'ArrowLeft') {
                          nextIndex =
                            (index - 1 + found.decks.length) % found.decks.length
                        }
                        if (event.key === 'Home') nextIndex = 0
                        if (event.key === 'End') nextIndex = found.decks.length - 1
                        if (nextIndex === null) return
                        event.preventDefault()
                        setDeckSelection({ resultId: found.id, index: nextIndex })
                        deckTabRefs.current[nextIndex]?.focus()
                      }}
                      ref={(node) => {
                        deckTabRefs.current[index] = node
                      }}
                    />
                  )
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {!compactMode && found !== null && deck !== null && (
        <footer className="deck-info">
          <div>
            <span>Колода</span>
            <strong title={deck.label ?? undefined}>
              {deck.label ?? `Колода ${selectedDeck + 1}`}
            </strong>
          </div>
          <div>
            <strong>{deck.cards.length} / 8</strong>
            <span>карт</span>
          </div>
        </footer>
      )}

      {failed && view !== null && (
        <div className="widget-stale-notice" role="status">
          Показан последний результат
        </div>
      )}
      <div className="widget-feedback" data-visible={feedback !== ''} aria-live="polite">
        {feedback}
      </div>
    </main>
  )
}

function ControlButton({
  active,
  label,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className="widget-control"
      data-active={active}
      disabled={disabled}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function EmptyResult({ result }: { result: WidgetView['result'] }): React.JSX.Element {
  if (result === null) {
    return (
      <EmptyState
        title="Ожидание соперника"
        detail="Виджет обновится после найденного игрока."
      />
    )
  }
  if (result.kind === 'player_found') {
    return (
      <EmptyState title="Ожидание соперника" detail="Новый результат пока не получен." />
    )
  }
  const title =
    result.kind === 'player_not_found'
      ? 'Игрок не найден'
      : result.kind === 'recognition_failed'
        ? 'Данные не распознаны'
        : 'Ошибка сервиса'
  const tone =
    result.kind === 'recognition_failed'
      ? 'warning'
      : result.kind === 'service_error'
        ? 'danger'
        : 'neutral'
  return <EmptyState tone={tone} title={title} detail={result.message} />
}

function EmptyState({
  title,
  detail,
  tone = 'neutral',
  loading = false,
}: {
  title: string
  detail: string
  tone?: 'neutral' | 'warning' | 'danger'
  loading?: boolean
}): React.JSX.Element {
  return (
    <section
      className="widget-empty"
      data-tone={tone}
      data-loading={loading}
      aria-live="polite"
      aria-busy={loading}
    >
      <span aria-hidden="true">CR</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </section>
  )
}

interface CardView {
  name: string
  level: number | null
  evolutionLevel: number | null
  hasImage: boolean
}

function DeckCards({
  resultId,
  deckIndex,
  cards,
}: {
  resultId: string
  deckIndex: number
  cards: CardView[]
}): React.JSX.Element {
  const [images, setImages] = useState<(string | null)[]>(() => cards.map(() => null))

  useEffect(() => {
    const cancellation = new AbortController()
    const timers = new Set<number>()
    const loadedImages = cards.map(() => null as string | null)
    let settled = 0
    let firstPainted = false

    const wait = (delay: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer)
          resolve()
        }, delay)
        timers.add(timer)
      })

    const request = async (cardIndex: number): Promise<string | null> => {
      try {
        const asset = await window.crToolsWidget.getCardAsset({
          resultId,
          deckIndex,
          cardIndex,
        })
        return asset.kind === 'available' ? asset.dataUrl : null
      } catch {
        return null
      }
    }

    const paint = (): void => {
      if (isCancelled(cancellation.signal)) return
      firstPainted = true
      setImages([...loadedImages])
    }

    const firstPaintTimer = window.setTimeout(paint, 100)
    timers.add(firstPaintTimer)

    const retry = async (cardIndex: number): Promise<void> => {
      for (let attempt = 1; attempt < CARD_ASSET_MAX_ATTEMPTS; attempt += 1) {
        const delay = CARD_ASSET_RETRY_DELAYS_MS[attempt - 1]
        if (delay === undefined) return
        await wait(delay)
        if (isCancelled(cancellation.signal)) return
        const retried = await request(cardIndex)
        if (isCancelled(cancellation.signal)) return
        if (retried !== null) {
          loadedImages[cardIndex] = retried
          setImages((current) => {
            const next = [...current]
            next[cardIndex] = retried
            return next
          })
          return
        }
      }
    }

    cards.forEach((card, cardIndex) => {
      void (card.hasImage ? request(cardIndex) : Promise.resolve(null)).then((image) => {
        if (isCancelled(cancellation.signal)) return
        loadedImages[cardIndex] = image
        settled += 1
        if (settled === cards.length && !firstPainted) {
          window.clearTimeout(firstPaintTimer)
          timers.delete(firstPaintTimer)
          paint()
        } else if (firstPainted && image !== null) {
          setImages((current) => {
            const next = [...current]
            next[cardIndex] = image
            return next
          })
        }
        if (image === null && card.hasImage) void retry(cardIndex)
      })
    })

    return () => {
      cancellation.abort()
      for (const timer of timers) window.clearTimeout(timer)
      timers.clear()
    }
  }, [cards, deckIndex, resultId])

  return (
    <>
      {cards.map((card, cardIndex) => (
        <Card
          key={`${cardIndex}-${card.name}-${card.hasImage}`}
          card={card}
          image={images[cardIndex] ?? null}
        />
      ))}
    </>
  )
}

function Card({
  card,
  image,
}: {
  card: CardView
  image: string | null
}): React.JSX.Element {
  const [decodeFailed, setDecodeFailed] = useState(false)

  const initials = card.name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

  return (
    <article className="deck-card" aria-label={card.name} title={card.name}>
      {!card.hasImage || image === null || decodeFailed ? (
        <span className="card-placeholder">{initials}</span>
      ) : (
        <img
          src={image}
          alt=""
          draggable={false}
          loading="eager"
          onError={() => setDecodeFailed(true)}
        />
      )}
    </article>
  )
}
