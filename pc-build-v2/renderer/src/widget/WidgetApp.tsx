import { Eye, EyeOff, LayoutGrid, Lock, Pin, Unlock, X } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

import type { WidgetSettings, WidgetView } from '../../../shared/models/widget'

export function WidgetApp(): React.JSX.Element {
  const [view, setView] = useState<WidgetView | null>(null)
  const [deckSelection, setDeckSelection] = useState({ resultId: '', index: 0 })
  const [failed, setFailed] = useState(false)
  const [pendingMutations, setPendingMutations] = useState(0)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [opacityDraft, setOpacityDraft] = useState(95)
  const [opacityDirty, setOpacityDirty] = useState(false)
  const deckTabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingMutationsRef = useRef(0)
  const mountedRef = useRef(true)

  const saving = pendingMutations > 0

  useEffect(
    () => () => {
      mountedRef.current = false
    },
    [],
  )

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
      let nextView: WidgetView | null = null
      try {
        nextView = await window.crToolsWidget.getView()
        if (active) {
          if (pendingMutationsRef.current === 0) setView(nextView)
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
      const hasResult = nextView?.result !== null && nextView?.result !== undefined
      const delay = document.hidden ? 5_000 : hasResult ? 2_500 : 1_000
      schedule(delay)
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

  const resultId = view?.result?.id ?? null
  const selectedDeck = deckSelection.resultId === resultId ? deckSelection.index : 0

  const enqueueSettings = (patch: Partial<WidgetSettings>): Promise<boolean> => {
    pendingMutationsRef.current += 1
    setPendingMutations((current) => current + 1)
    setMutationError(null)
    setSaved(false)

    const mutation = mutationQueueRef.current.then(async () => {
      const latestView = await window.crToolsWidget.getView()
      const settings = await window.crToolsWidget.updateSettings({
        ...latestView.settings,
        ...patch,
      })
      if (mountedRef.current) setView({ ...latestView, settings })
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
    if (!opacityDirty) return
    let active = true
    const timer = window.setTimeout(() => {
      void enqueueSettingsEvent({ opacity: opacityDraft / 100 }).then((updated) => {
        if (!active) return
        setOpacityDirty(false)
        if (!updated) setMutationError('Не удалось сохранить прозрачность.')
      })
    }, 300)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [opacityDirty, opacityDraft])

  const displayedOpacity =
    opacityDirty || view === null ? opacityDraft : Math.round(view.settings.opacity * 100)

  const result = view?.result ?? null
  const found = result?.kind === 'player_found' ? result : null
  const deck = found?.decks[selectedDeck] ?? null

  return (
    <main className="widget-shell" data-compact={view?.settings.compactMode ?? false}>
      <header className="widget-header">
        <div className="widget-brand">
          <span>CR TOOLS</span>
          <strong>Соперник</strong>
        </div>
        {view !== null && (
          <div className="widget-controls" aria-label="Настройки окна">
            <ControlButton
              active={view.settings.alwaysOnTop}
              label="Поверх остальных окон"
              disabled={saving}
              onClick={() =>
                void enqueueSettings({
                  alwaysOnTop: !view.settings.alwaysOnTop,
                })
              }
            >
              <Pin aria-hidden="true" size={15} />
            </ControlButton>
            <ControlButton
              active={view.settings.locked}
              label={view.settings.locked ? 'Разблокировать окно' : 'Заблокировать окно'}
              disabled={saving}
              onClick={() => void enqueueSettings({ locked: !view.settings.locked })}
            >
              {view.settings.locked ? (
                <Lock aria-hidden="true" size={15} />
              ) : (
                <Unlock aria-hidden="true" size={15} />
              )}
            </ControlButton>
            <ControlButton
              active={view.settings.compactMode}
              label="Компактный режим"
              disabled={saving}
              onClick={() =>
                void enqueueSettings({
                  compactMode: !view.settings.compactMode,
                })
              }
            >
              <LayoutGrid aria-hidden="true" size={15} />
            </ControlButton>
            <button
              className="widget-control"
              type="button"
              aria-label="Скрыть виджет"
              title="Скрыть виджет"
              onClick={() => void window.crToolsWidget.hide()}
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        )}
      </header>

      {view !== null && (
        <label className="opacity-control">
          {displayedOpacity < 80 ? (
            <EyeOff aria-hidden="true" size={14} />
          ) : (
            <Eye aria-hidden="true" size={14} />
          )}
          <span>Прозрачность</span>
          <input
            aria-label="Прозрачность виджета"
            type="range"
            min="55"
            max="100"
            step="5"
            disabled={saving}
            value={displayedOpacity}
            onChange={(event) => {
              setOpacityDraft(Number(event.currentTarget.value))
              setOpacityDirty(true)
              setSaved(false)
            }}
          />
          <output>{displayedOpacity}%</output>
        </label>
      )}

      <div className="widget-mutation-status" aria-live="polite">
        {saving
          ? 'Сохраняем настройку...'
          : (mutationError ?? (saved ? 'Настройка сохранена' : ''))}
      </div>

      {failed && view !== null && (
        <div className="widget-stale-notice" role="status">
          Не удалось обновить данные. Показан последний результат.
        </div>
      )}

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
      ) : (
        <>
          <section className="player-summary" aria-labelledby="player-name">
            <div className="player-heading">
              <div>
                <span>НАЙДЕН ИГРОК</span>
                <h1 id="player-name">{found.player.name}</h1>
              </div>
              {found.player.rating !== null && (
                <strong className="rating" aria-label={`Рейтинг ${found.player.rating}`}>
                  {found.player.rating}
                </strong>
              )}
            </div>
            <dl>
              <div>
                <dt>Тег</dt>
                <dd>{found.player.tag ?? 'Не указан'}</dd>
              </div>
              <div>
                <dt>Клан</dt>
                <dd>{found.player.clan ?? 'Без клана'}</dd>
              </div>
            </dl>
          </section>

          {found.decks.length === 0 ? (
            <EmptyState
              title="Колоды не найдены"
              detail="Профиль игрока получен без колод."
            />
          ) : (
            <section className="deck-section" aria-label="Колоды игрока">
              <div className="deck-tabs" role="tablist" aria-label="Выбор колоды">
                {found.decks.map((item, index) => (
                  <button
                    key={`${item.label ?? 'deck'}-${index}`}
                    type="button"
                    role="tab"
                    id={`deck-tab-${index}`}
                    aria-controls={`deck-panel-${index}`}
                    aria-selected={selectedDeck === index}
                    tabIndex={selectedDeck === index ? 0 : -1}
                    onClick={() => setDeckSelection({ resultId: found.id, index })}
                    onKeyDown={(event) => {
                      let nextIndex: number | null = null
                      if (event.key === 'ArrowRight') {
                        nextIndex = (index + 1) % found.decks.length
                      }
                      if (event.key === 'ArrowLeft') {
                        nextIndex = (index - 1 + found.decks.length) % found.decks.length
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
                  >
                    {item.label ?? `Колода ${index + 1}`}
                  </button>
                ))}
              </div>
              <div
                className="card-grid"
                id={`deck-panel-${selectedDeck}`}
                role="tabpanel"
                aria-labelledby={`deck-tab-${selectedDeck}`}
              >
                {deck?.cards.map((card, cardIndex) => (
                  <Card
                    key={`${found.id}-${selectedDeck}-${cardIndex}`}
                    resultId={found.id}
                    deckIndex={selectedDeck}
                    cardIndex={cardIndex}
                    card={card}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
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
        detail="Запустите монитор или дождитесь нового результата."
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

function Card({
  resultId,
  deckIndex,
  cardIndex,
  card,
}: {
  resultId: string
  deckIndex: number
  cardIndex: number
  card: CardView
}): React.JSX.Element {
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (card.hasImage) {
      void window.crToolsWidget
        .getCardAsset({ resultId, deckIndex, cardIndex })
        .then((asset) => {
          if (active && asset.kind === 'available') setImage(asset.dataUrl)
        })
        .catch(() => undefined)
    }
    return () => {
      active = false
    }
  }, [card.hasImage, cardIndex, deckIndex, resultId])

  const initials = card.name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

  return (
    <article className="deck-card">
      <div className="card-art">
        {image === null ? (
          <span>{initials}</span>
        ) : (
          <img src={image} alt="" onError={() => setImage(null)} />
        )}
      </div>
      <div className="card-copy">
        <strong title={card.name}>{card.name}</strong>
        <span>
          {card.level === null ? 'Уровень неизвестен' : `Уровень ${card.level}`}
        </span>
        {card.evolutionLevel !== null && card.evolutionLevel > 0 && (
          <small>Эволюция {card.evolutionLevel}</small>
        )}
      </div>
    </article>
  )
}
