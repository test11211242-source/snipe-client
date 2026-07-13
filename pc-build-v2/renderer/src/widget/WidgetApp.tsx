import { Eye, EyeOff, LayoutGrid, Lock, Pin, Unlock, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { WidgetSettings, WidgetView } from '../../../shared/models/widget'

export function WidgetApp(): React.JSX.Element {
  const [view, setView] = useState<WidgetView | null>(null)
  const [deckSelection, setDeckSelection] = useState({ resultId: '', index: 0 })
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    const load = (): void => {
      void window.crToolsWidget.getView().then(
        (nextView) => {
          if (!active) return
          setView(nextView)
          setFailed(false)
        },
        () => {
          if (active) setFailed(true)
        },
      )
    }
    load()
    const timer = setInterval(load, 1_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const resultId = view?.result?.id ?? null
  const selectedDeck = deckSelection.resultId === resultId ? deckSelection.index : 0

  const updateSettings = async (patch: Partial<WidgetSettings>): Promise<void> => {
    if (view === null) return
    const settings = await window.crToolsWidget.updateSettings({
      ...view.settings,
      ...patch,
    })
    setView((current) => (current === null ? current : { ...current, settings }))
  }

  const result = view?.result ?? null
  const found = result?.kind === 'player_found' ? result : null
  const deck = found?.decks[selectedDeck] ?? null

  return (
    <main className="widget-shell" data-compact={view?.settings.compactMode ?? false}>
      <header className="widget-header">
        <div className="widget-brand">
          <span>CR TOOLS</span>
          <strong>Opponent</strong>
        </div>
        {view !== null && (
          <div className="widget-controls" aria-label="Настройки окна">
            <ControlButton
              active={view.settings.alwaysOnTop}
              label="Поверх остальных окон"
              onClick={() =>
                void updateSettings({ alwaysOnTop: !view.settings.alwaysOnTop })
              }
            >
              <Pin aria-hidden="true" size={15} />
            </ControlButton>
            <ControlButton
              active={view.settings.locked}
              label={view.settings.locked ? 'Разблокировать окно' : 'Заблокировать окно'}
              onClick={() => void updateSettings({ locked: !view.settings.locked })}
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
              onClick={() =>
                void updateSettings({ compactMode: !view.settings.compactMode })
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
          {view.settings.opacity < 0.8 ? (
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
            value={Math.round(view.settings.opacity * 100)}
            onChange={(event) =>
              void updateSettings({ opacity: Number(event.currentTarget.value) / 100 })
            }
          />
          <output>{Math.round(view.settings.opacity * 100)}%</output>
        </label>
      )}

      {failed ? (
        <EmptyState
          title="Виджет временно недоступен"
          detail="Повторная проверка выполняется."
        />
      ) : view === null ? (
        <EmptyState
          title="Загрузка результата"
          detail="Подключение к локальному монитору."
        />
      ) : found === null ? (
        <EmptyResult result={result} />
      ) : (
        <>
          <section className="player-summary" aria-labelledby="player-name">
            <div>
              <span>НАЙДЕН ИГРОК</span>
              <h1 id="player-name">{found.player.name}</h1>
            </div>
            {found.player.rating !== null && (
              <strong className="rating" aria-label={`Рейтинг ${found.player.rating}`}>
                {found.player.rating}
              </strong>
            )}
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
                    aria-selected={selectedDeck === index}
                    onClick={() => setDeckSelection({ resultId: found.id, index })}
                  >
                    {item.label ?? `Колода ${index + 1}`}
                  </button>
                ))}
              </div>
              <div className="card-grid">
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
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className="widget-control"
      data-active={active}
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
  return <EmptyState title={title} detail={result.message} />
}

function EmptyState({
  title,
  detail,
}: {
  title: string
  detail: string
}): React.JSX.Element {
  return (
    <section className="widget-empty" aria-live="polite">
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
