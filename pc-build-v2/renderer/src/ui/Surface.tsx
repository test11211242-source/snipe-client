import type { ElementType, HTMLAttributes, ReactNode } from 'react'

import { LinkButton } from './Button'
import { cx } from './cx'
import { Icon } from './Icon'
import styles from './Surface.module.css'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType
  padded?: boolean
  flush?: boolean
}

/** Surface-1 card with a 1 px ring. */
export function Card({
  as: Tag = 'section',
  padded = false,
  flush = false,
  className,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <Tag
      {...rest}
      className={cx(
        styles['card'],
        padded && styles['pad'],
        flush && styles['flush'],
        className,
      )}
    />
  )
}

export interface RowProps {
  /** Left tile (icon). */
  lead?: ReactNode
  title: ReactNode
  /** One line of explanation. */
  sub?: ReactNode
  warnSub?: boolean
  /** State/action on the right. */
  trail?: ReactNode
  /** Makes the whole row a button. */
  onClick?: () => void
  selected?: boolean
  bordered?: boolean
  className?: string
  'aria-label'?: string
  'aria-current'?: 'true' | 'page'
}

/** List row: icon · title + one line · state/action. */
export function Row({
  lead,
  title,
  sub,
  warnSub = false,
  trail,
  onClick,
  selected = false,
  bordered = false,
  className,
  ...aria
}: RowProps): React.JSX.Element {
  const classes = cx(
    styles['row'],
    onClick !== undefined && styles['interactive'],
    selected && styles['selected'],
    bordered && styles['bordered'],
    className,
  )
  const body = (
    <>
      {lead === undefined ? null : <span className={styles['lead']}>{lead}</span>}
      <span className={styles['main']}>
        <span className={styles['title']}>{title}</span>
        {sub === undefined ? null : (
          <span className={cx(styles['sub'], warnSub && styles['subWarn'])}>{sub}</span>
        )}
      </span>
      {trail === undefined ? null : <span className={styles['trail']}>{trail}</span>}
    </>
  )
  return onClick === undefined ? (
    <div {...aria} className={classes}>
      {body}
    </div>
  ) : (
    <button {...aria} className={classes} onClick={onClick} type="button">
      {body}
    </button>
  )
}

/** Titled group of settings or rows. */
export function Group({
  title,
  trail,
  children,
}: {
  title: string
  trail?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className={styles['group']}>
      <h3 className={styles['groupTitle']}>
        <span>{title}</span>
        {trail}
      </h3>
      {children}
    </section>
  )
}

/** Setting row: title + hint left, control right. Controls apply immediately. */
export function Setting({
  title,
  hint,
  children,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className={styles['setting']}>
      <div className={styles['settingText']}>
        <span className={styles['settingTitle']}>{title}</span>
        {hint === undefined ? null : (
          <span className={styles['settingHint']}>{hint}</span>
        )}
      </div>
      <div className={styles['settingControl']}>{children}</div>
    </div>
  )
}

export interface Requirement {
  id: string
  name: string
  /** Current state in words, e.g. "@artcs_cr" or "не подключён". */
  state: string
  ok: boolean
  /** Fix action in the single owning page. Required for unmet requirements. */
  action?: { label: string; onAction: () => void }
}

/**
 * «Нужно для работы»: all met → compact chips (links to the owning page); something
 * missing → rows with the fix button. Never duplicates the owner's own controls.
 */
export function Requirements({
  items,
  title = 'Нужно для работы',
  note,
}: {
  items: readonly Requirement[]
  title?: string
  note?: ReactNode
}): React.JSX.Element {
  const allOk = items.every((item) => item.ok)
  if (allOk) {
    return (
      <div className={cx(styles['needs'], styles['needsOk'])}>
        <span className={styles['needsTitle']}>{title}</span>
        <div className={styles['needChips']}>
          {items.map((item) =>
            item.action === undefined ? (
              <span className={styles['needChip']} key={item.id}>
                <Icon name="check" size={12} />
                {item.name}: {item.state}
              </span>
            ) : (
              <button
                className={styles['needChip']}
                key={item.id}
                onClick={item.action.onAction}
                type="button"
              >
                <Icon name="check" size={12} />
                {item.name}: {item.state}
              </button>
            ),
          )}
        </div>
        {note === undefined ? null : <div className={styles['needNote']}>{note}</div>}
      </div>
    )
  }
  return (
    <div className={cx(styles['needs'], styles['needsBad'])}>
      <span className={styles['needsTitle']}>{title}</span>
      {items.map((item) => (
        <div className={cx(styles['need'], !item.ok && styles['needBad'])} key={item.id}>
          <span className={styles['needMark']}>
            <Icon name={item.ok ? 'check' : 'alert'} size={13} />
          </span>
          <span className={styles['needName']}>{item.name}</span>
          <span className={styles['needState']}>{item.state}</span>
          {item.action === undefined ? null : (
            <LinkButton
              onClick={item.action.onAction}
              tone={item.ok ? 'default' : 'warn'}
            >
              {item.action.label}
              <Icon name="chevronRight" size={12} />
            </LinkButton>
          )}
        </div>
      ))}
      {note === undefined ? null : <div className={styles['needNote']}>{note}</div>}
    </div>
  )
}
