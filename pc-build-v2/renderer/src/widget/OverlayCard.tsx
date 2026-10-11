import type { CSSProperties } from 'react'

import type { WidgetView } from '../../../shared/models/widget'
import {
  CardTile,
  ClanLine,
  DeckTabs,
  Dot,
  Icon,
  IconButton,
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
  compact,
}: {
  result: Found
  deckIndex: number
  compact: boolean
}): React.JSX.Element {
  const cards = result.decks[deckIndex]?.cards ?? []
  const images = useCardImages(
    result.id,
    deckIndex,
    cards.map((card) => card.hasImage),
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
    '--cols': compact ? 8 : 4,
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
      <header className={styles['top']}>
        <span className={styles['status']} data-tone={model.tone}>
          {model.busy ? (
            <Spinner />
          ) : (
            <Dot live={model.tone === 'ok'} tone={model.tone} />
          )}
          {model.status}
        </span>
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
          <div className={styles['who']}>
            <h1 className={styles['name']} title={body.result.player.name}>
              {body.result.player.name}
            </h1>
            {body.result.player.rating === null ? null : (
              <span
                aria-label={`Рейтинг ${body.result.player.rating}`}
                className={styles['rating']}
              >
                <Icon name="medal" size={14} />
                {body.result.player.rating.toLocaleString('ru-RU')}
              </span>
            )}
          </div>
          <ClanLine clan={body.result.player.clan} />
          {body.result.decks.length === 0 ? (
            <p className={styles['text']}>Профиль игрока получен без колод.</p>
          ) : (
            <>
              <OverlayDeck
                compact={compact}
                deckIndex={deckIndex}
                key={`${body.result.id}:${deckIndex}`}
                result={body.result}
              />
              <div className={styles['foot']}>
                <DeckTabs
                  count={body.result.decks.length}
                  onSelect={onDeck}
                  selected={deckIndex}
                />
              </div>
            </>
          )}
        </>
      ) : body.kind === 'searching' ? (
        <div aria-busy="true" className={styles['message']}>
          {body.nickname === null ? null : (
            <h1 className={styles['name']}>{body.nickname}</h1>
          )}
          <p className={styles['text']}>
            {body.nickname === null ? 'Читаем ник…' : 'Ищем игрока в базе…'}
          </p>
        </div>
      ) : (
        <div className={styles['message']}>
          <h1 className={cx(styles['name'], styles['messageTitle'])}>{body.title}</h1>
          <p className={styles['text']}>{body.text}</p>
        </div>
      )}

      {notice === null ? null : (
        <p className={styles['notice']} role="status">
          {notice}
        </p>
      )}
    </main>
  )
}
