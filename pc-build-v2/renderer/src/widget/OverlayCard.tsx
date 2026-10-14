import type { CSSProperties } from 'react'

import type { WidgetView } from '../../../shared/models/widget'
import {
  CardTile,
  ClanLine,
  DeckTabs,
  Dot,
  Icon,
  IconButton,
  Rating,
  Spinner,
  type DeckCardData,
} from '../ui'
import { cx } from '../ui/cx'
import { useCardImages } from '../features/cards/useCardImages'
import type {
  CardAssetRequest,
  CardAssetResult,
} from '../../../shared/contracts/widget-ipc'
import type { OverlayBody, OverlayModel } from './overlayModel'
import styles from './Overlay.module.css'

type Found = Extract<OverlayBody, { kind: 'found' }>['result']

const fetchWidgetAsset = (request: CardAssetRequest): Promise<CardAssetResult> =>
  window.crToolsWidget.getCardAsset(request)

function OverlayDeck({
  result,
  deckIndex,
  art,
}: {
  result: Found
  deckIndex: number
  art: boolean
}): React.JSX.Element {
  const cards = result.decks[deckIndex]?.cards ?? []
  const images = useCardImages(
    result.id,
    deckIndex,
    cards.map((card) => art && card.hasImage),
    fetchWidgetAsset,
  )
  const slots: (DeckCardData | null)[] = Array.from({ length: 8 }, (_, index) => {
    const card = cards[index]
    if (card === undefined) return null
    return {
      name: card.name,
      iconUrl: images[index]?.src ?? null,
      pending: images[index]?.pending ?? false,
    }
  })
  const style: CSSProperties & { '--cols': number; '--tile-w': string } = {
    '--cols': 4,
    '--tile-w': '100%',
  }
  return (
    <ul
      aria-label={`Карты колоды ${deckIndex + 1}`}
      className={styles['deck']}
      style={style}
    >
      {slots.map((slot, index) => (
        <li key={index}>
          <CardTile card={slot} />
        </li>
      ))}
    </ul>
  )
}

export interface OverlayControls {
  /** Disabled while a settings write is in flight. */
  disabled: boolean
  onPin: () => void
  onLock: () => void
  onCompact: () => void
  onHide: () => void
}

/**
 * The overlay window. Everything scales with `view.scale` (`--ow-k`); the shell has no
 * fixed height so its measured height is the content height reported to main.
 */
export function OverlayCard({
  view,
  model,
  compact,
  deckIndex,
  onDeck,
  controls,
  notice,
  shellRef,
  measuring = false,
}: {
  view: WidgetView
  model: OverlayModel
  compact: boolean
  deckIndex: number
  onDeck: (index: number) => void
  controls: OverlayControls
  /** Calm one-line notice (reprocessed entry, save error). */
  notice: string | null
  shellRef: React.Ref<HTMLElement>
  /** Hidden copy measured before a mode switch: no card art requests (tiles keep size). */
  measuring?: boolean
}): React.JSX.Element {
  const { settings } = view
  const body = model.body
  const style: CSSProperties & { '--ow-k': number } = { '--ow-k': view.scale }
  return (
    <main
      className={styles['shell']}
      data-compact={compact}
      data-locked={settings.locked}
      data-pinned={settings.alwaysOnTop}
      ref={shellRef}
      style={style}
    >
      {/* Compact collapses this strip to zero height, so each body marks its own handle. */}
      <header className={styles['top']} data-drag-handle={compact ? undefined : true}>
        {compact ? null : (
          <span className={styles['status']} data-tone={model.tone}>
            {model.busy ? (
              <Spinner />
            ) : (
              <Dot live={model.tone === 'ok'} tone={model.tone} />
            )}
            {model.status}
          </span>
        )}
        <div aria-label="Управление оверлеем" className={styles['controls']} role="group">
          <IconButton
            active={settings.alwaysOnTop}
            aria-pressed={settings.alwaysOnTop}
            disabled={controls.disabled}
            label={
              settings.alwaysOnTop
                ? 'Открепить от переднего плана'
                : 'Закрепить поверх окон'
            }
            onClick={controls.onPin}
            size="sm"
          >
            <Icon name="pin" size={14} />
          </IconButton>
          <IconButton
            active={settings.locked}
            aria-pressed={settings.locked}
            disabled={controls.disabled}
            label={settings.locked ? 'Разблокировать позицию' : 'Заблокировать позицию'}
            onClick={controls.onLock}
            size="sm"
          >
            <Icon name="lock" size={14} />
          </IconButton>
          <IconButton
            active={compact}
            aria-pressed={compact}
            disabled={controls.disabled}
            label={compact ? 'Полный вид' : 'Компактный вид'}
            onClick={controls.onCompact}
            size="sm"
          >
            <Icon name="compact" size={14} />
          </IconButton>
          <IconButton label="Скрыть оверлей" onClick={controls.onHide} size="sm">
            <Icon name="close" size={14} />
          </IconButton>
        </div>
      </header>

      {body.kind === 'found' ? (
        <>
          <div className={styles['who']} data-drag-handle={compact ? true : undefined}>
            <h1 className={styles['name']} title={body.result.player.name}>
              {body.result.player.name}
            </h1>
            {body.result.player.rating === null ? null : (
              <span className={styles['rating']}>
                <Rating value={body.result.player.rating} />
              </span>
            )}
            {compact && body.result.decks.length > 1 ? (
              <div aria-label="Колоды" className={styles['switcher']} role="tablist">
                {body.result.decks.map((_, index) => (
                  <button
                    aria-label={`Колода ${index + 1}`}
                    aria-selected={index === deckIndex}
                    key={index}
                    onClick={() => onDeck(index)}
                    role="tab"
                    type="button"
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {compact ? null : <ClanLine clan={body.result.player.clan} />}
          {body.result.decks.length === 0 && !compact ? (
            <p className={styles['text']}>Профиль игрока получен без колод.</p>
          ) : (
            <>
              <OverlayDeck
                art={!measuring}
                deckIndex={deckIndex}
                key={`${body.result.id}:${deckIndex}`}
                result={body.result}
              />
              {!compact && body.result.decks.length > 1 ? (
                <div className={styles['foot']}>
                  <DeckTabs
                    count={body.result.decks.length}
                    onSelect={onDeck}
                    selected={deckIndex}
                  />
                </div>
              ) : null}
            </>
          )}
        </>
      ) : body.kind === 'searching' ? (
        <div aria-busy="true" className={styles['message']} data-drag-handle>
          {body.nickname === null ? null : (
            <h1 className={styles['name']}>{body.nickname}</h1>
          )}
          <p className={styles['text']}>
            {body.nickname === null ? 'Читаем ник…' : 'Ищем игрока в базе…'}
          </p>
        </div>
      ) : (
        <div className={styles['message']} data-drag-handle>
          <h1 className={cx(styles['name'], styles['messageTitle'])}>{body.title}</h1>
          <p className={styles['text']}>{body.text}</p>
        </div>
      )}

      {notice === null || compact ? null : (
        <p className={styles['notice']} role="status">
          {notice}
        </p>
      )}
    </main>
  )
}
