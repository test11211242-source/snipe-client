import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'

import { cx } from './cx'
import { Skeleton } from './Feedback'
import { Icon } from './Icon'
import styles from './Game.module.css'
import ratingIcon from './assets/rating.png'

/** Rating: always the medal icon + number. */
export function Rating({
  value,
  large = false,
}: {
  value: number
  large?: boolean
}): React.JSX.Element {
  return (
    <span
      aria-label={`Рейтинг ${value}`}
      className={cx(styles['rating'], large && styles['ratingLg'])}
    >
      <img alt="" aria-hidden="true" src={ratingIcon} />
      <b>{value.toLocaleString('ru-RU')}</b>
    </span>
  )
}

/** Player tag. With `onCopy` it is a button: check mark for 1.5 s after a copy. */
export function TagChip({
  tag,
  onCopy,
}: {
  tag: string
  /** Resolves true when the tag was copied. */
  onCopy?: ((tag: string) => Promise<boolean> | boolean) | undefined
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (onCopy === undefined)
    return <span className={cx(styles['tag'], styles['tagStatic'])}>{tag}</span>
  return (
    <button
      aria-label={`Скопировать тег ${tag}`}
      className={cx(styles['tag'], copied && styles['tagOk'])}
      onClick={() => {
        void Promise.resolve(onCopy(tag)).then((done) => {
          if (!done) return
          setCopied(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 1500)
        })
      }}
      type="button"
    >
      {tag}
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </button>
  )
}

/** Clan on its own line with a shield; "Без клана" when null. */
export function ClanLine({ clan }: { clan: string | null }): React.JSX.Element {
  return (
    <div className={cx(styles['clan'], clan === null && styles['clanNone'])}>
      <Icon name="shield" size={15} />
      <span>{clan ?? 'Без клана'}</span>
    </div>
  )
}

export interface DeckCardData {
  name: string
  /** Displayable image source; null → placeholder. */
  iconUrl: string | null
  /** Art is still being fetched: skeleton instead of the placeholder. */
  pending?: boolean
}

type TileStyle = CSSProperties & { '--tile-w'?: string; '--cols'?: number }

/**
 * The card is only its artwork (5:6): no backing tile, no level, no evolution/hero badge.
 * `name` is alt text and tooltip.
 */
export function CardTile({
  card,
  loading = false,
}: {
  card: DeckCardData | null
  loading?: boolean
}): React.JSX.Element {
  if (loading || card?.pending === true)
    return <Skeleton className={cx(styles['tile'], styles['tileLoading'])} />
  if (card?.iconUrl == null) return <TileEmpty card={card} />
  return <TileArt iconUrl={card.iconUrl} name={card.name} />
}

function TileEmpty({ card }: { card: DeckCardData | null }): React.JSX.Element {
  return (
    <span
      aria-label={card?.name}
      className={cx(styles['tile'], styles['tileEmpty'])}
      role={card === null ? undefined : 'img'}
    >
      <Icon name="layers" size={28} />
    </span>
  )
}

/** Remote art that fails to decode falls back to the same placeholder. */
function TileArt({
  iconUrl,
  name,
}: {
  iconUrl: string
  name: string
}): React.JSX.Element {
  const [failed, setFailed] = useState<string | null>(null)
  if (failed === iconUrl) return <TileEmpty card={{ name, iconUrl: null }} />
  return (
    <span className={styles['tile']} title={name}>
      <img
        alt={name}
        className={styles['tileImg']}
        draggable={false}
        onError={() => setFailed(iconUrl)}
        src={iconUrl}
      />
    </span>
  )
}

export interface DeckProps {
  cards: readonly DeckCardData[]
  /** Card width in px (design: 108 wide, 84 medium, 82 mini, 74 overlay). */
  tileWidth?: number
  /** 4 (4×2) or 8 (one row). */
  columns?: 4 | 8
  showNames?: boolean
  loading?: boolean
  /** Accessible name of the list. */
  label: string
}

/** Always eight slots; missing cards render as empty slots. */
export function Deck({
  cards,
  tileWidth = 108,
  columns = 4,
  showNames = true,
  loading = false,
  label,
}: DeckProps): React.JSX.Element {
  const style: TileStyle = { '--tile-w': `${tileWidth}px`, '--cols': columns }
  return (
    <ul aria-label={label} className={styles['deck']} style={style}>
      {Array.from({ length: 8 }, (_, index) => {
        const card = cards[index] ?? null
        return (
          <li className={styles['cell']} key={index}>
            <CardTile card={card} loading={loading} />
            {showNames && card !== null ? (
              <span className={styles['cellName']}>{card.name}</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** Deck switcher 1–5 plus "Колода N из M". Hidden when there is a single deck. */
export function DeckTabs({
  count,
  selected,
  onSelect,
  label,
}: {
  count: number
  /** Zero-based. */
  selected: number
  onSelect: (index: number) => void
  /** Optional real deck name ("Колода 2 из 3 · {name}"). */
  label?: string | null
}): React.JSX.Element | null {
  if (count < 2) return null
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    const next = (selected + delta + count) % count
    onSelect(next)
    const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
    tabs[next]?.focus()
  }
  return (
    <div className={styles['tabsBar']}>
      <div
        aria-label="Колоды соперника"
        className={styles['tabs']}
        onKeyDown={onKeyDown}
        role="tablist"
      >
        {Array.from({ length: count }, (_, index) => (
          <button
            aria-label={`Колода ${index + 1}`}
            aria-selected={index === selected}
            className={styles['tab']}
            key={index}
            onClick={() => onSelect(index)}
            role="tab"
            tabIndex={index === selected ? 0 : -1}
            type="button"
          >
            {index + 1}
          </button>
        ))}
      </div>
      <span className={styles['deckLabel']}>
        Колода <b>{selected + 1}</b> из {count}
        {label === undefined || label === null ? '' : ` · ${label}`}
      </span>
    </div>
  )
}
