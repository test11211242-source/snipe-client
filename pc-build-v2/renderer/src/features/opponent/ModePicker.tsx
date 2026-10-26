import { useCallback, useEffect, useState } from 'react'

import type { GameEvent } from '../../../../shared/contracts/game-events'
import type { DeckMode, PickedEvent } from '../../../../shared/models/monitor'
import { Icon, Menu, MenuHeader, MenuItem, MenuSeparator } from '../../ui'
import styles from './ModePicker.module.css'
import { isNew, modeIcon, modeLabel, subtitle } from './modes'

function Option({
  icon,
  title,
  note,
  badge,
  selected,
  disabled,
  index,
  onSelect,
}: {
  icon: string
  title: string
  note?: string
  badge?: string | null
  selected: boolean
  disabled?: boolean
  index: number
  onSelect: () => void
}): React.JSX.Element {
  return (
    <MenuItem
      aria-current={selected ? 'true' : undefined}
      className={styles['option']}
      data-selected={selected}
      disabled={disabled}
      onSelect={onSelect}
      style={{ '--i': index } as React.CSSProperties}
    >
      <img alt="" className={styles['icon']} draggable={false} src={icon} />
      <span className={styles['text']}>
        <span className={styles['title']}>
          <span className={styles['name']}>{title}</span>
          {badge == null ? null : <span className={styles['badge']}>{badge}</span>}
        </span>
        {note === undefined ? null : <span className={styles['note']}>{note}</span>}
      </span>
      <span aria-hidden className={styles['check']}>
        <Icon name="check" size={12} />
      </span>
    </MenuItem>
  )
}

/**
 * The search mode, shared with the site through the server (owner, 26.10.2026): Path of
 * Legends, Grand Tournament, or one of the 1v1 events in the game right now.
 */
export function ModePicker({
  deckMode,
  event,
  disabled,
  onPick,
}: {
  deckMode: DeckMode
  event: PickedEvent | null
  disabled: boolean
  onPick: (mode: DeckMode, event: PickedEvent | null) => void
}): React.JSX.Element {
  const [events, setEvents] = useState<GameEvent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const show = useCallback((list: GameEvent[] | null): void => {
    setEvents(list)
    setFailed(list === null)
    setNow(Date.now())
  }, [])

  // Also takes the mode picked on the site since: main updates the view.
  const load = useCallback(async (): Promise<void> => {
    try {
      show((await window.crTools.getModeOptions()).events)
    } catch {
      setFailed(true)
    }
  }, [show])

  useEffect(() => {
    if (disabled) return
    let active = true
    window.crTools.getModeOptions().then(
      (options) => {
        if (active) show(options.events)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [disabled, show])

  const picked = deckMode === 'challenge' ? event : null
  // Before the list loads the picked event still gets a challenge badge from its title.
  const look =
    events?.find((item) => item.tag === picked?.tag) ??
    (picked === null ? null : { title: picked.title, kind: 'challenge', max_wins: null })
  const label = modeLabel(deckMode, picked)

  return (
    <Menu
      align="end"
      label="Режим поиска"
      trigger={({ open, props }) => (
        <button
          {...props}
          className={styles['trigger']}
          data-open={open}
          disabled={disabled}
          onClick={() => {
            if (!open) void load()
            props.onClick()
          }}
          title="Режим поиска: применится к следующему поиску"
          type="button"
        >
          <img
            alt=""
            className={styles['triggerIcon']}
            draggable={false}
            src={modeIcon(deckMode, look)}
          />
          <span className={styles['triggerLabel']}>{label}</span>
          <span className={styles['chevron']}>
            <Icon name="chevronDown" size={14} />
          </span>
        </button>
      )}
      width={340}
    >
      <Option
        icon={modeIcon('pol')}
        index={0}
        onSelect={() => onPick('pol', null)}
        selected={deckMode === 'pol'}
        title="Путь легенд"
      />
      <Option
        icon={modeIcon('gt')}
        index={1}
        onSelect={() => onPick('gt', null)}
        selected={deckMode === 'gt'}
        title="Турнир"
      />
      <MenuSeparator />
      <MenuHeader>
        <span className={styles['live']}>
          <span aria-hidden className={styles['pulse']} />
          Ивенты в игре сейчас
        </span>
      </MenuHeader>
      {failed ? (
        <MenuItem
          className={styles['retry']}
          keepOpen
          onSelect={() => {
            setFailed(false)
            void load()
          }}
        >
          <Icon name="refresh" size={14} />
          Не удалось загрузить ивенты. Повторить
        </MenuItem>
      ) : events === null ? (
        <div className={styles['skeletons']}>
          <span className={styles['skeleton']} />
          <span className={styles['skeleton']} />
          <span className={styles['skeleton']} />
        </div>
      ) : events.length === 0 ? (
        <p className={styles['empty']}>Сейчас в игре нет ивентов 1 на 1.</p>
      ) : (
        events.map((item, index) => (
          <Option
            badge={isNew(item, now) ? 'Новый' : null}
            disabled={!item.active}
            icon={modeIcon('challenge', item)}
            index={index + 2}
            key={item.tag}
            note={subtitle(item)}
            onSelect={() => onPick('challenge', { tag: item.tag, title: item.title })}
            selected={picked?.tag === item.tag}
            title={item.title}
          />
        ))
      )}
    </Menu>
  )
}
