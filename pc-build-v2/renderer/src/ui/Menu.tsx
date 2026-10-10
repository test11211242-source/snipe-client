import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { cx } from './cx'
import { useDismiss } from './focus'
import styles from './Menu.module.css'

const MenuContext = createContext<{ close: () => void } | null>(null)

export interface MenuTriggerProps {
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string | undefined
  onClick: () => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export interface MenuProps {
  /** Renders the trigger; spread `props` on a single button. */
  trigger: (api: { open: boolean; props: MenuTriggerProps }) => ReactNode
  /** Accessible name of the menu. */
  label: string
  children: ReactNode
  align?: 'start' | 'end'
  direction?: 'down' | 'up'
  /** CSS width of the popup, e.g. 360 or "100%". */
  width?: number | string
  className?: string
}

function items(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
  )
}

/**
 * Popover menu: Esc/outside click close it, Arrow keys/Home/End move between items, the
 * trigger regains focus on close. Items call `close` through MenuItem.
 */
export function Menu({
  trigger,
  label,
  children,
  align = 'start',
  direction = 'down',
  width,
  className,
}: MenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const id = useId()

  // Keyboard-open asks for focus on the first/last item once the menu has mounted.
  const [focusRequest, setFocusRequest] = useState<'first' | 'last' | null>(null)
  const close = useCallback((): void => {
    setOpen(false)
    setFocusRequest(null)
    const toggle = root.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')
    toggle?.focus()
  }, [])
  useDismiss(root, open, () => {
    if (open) close()
  })

  const attachMenu = useCallback(
    (element: HTMLDivElement | null): void => {
      menu.current = element
      if (element === null || focusRequest === null) return
      const list = items(element)
      const target = focusRequest === 'first' ? list[0] : list[list.length - 1]
      target?.focus()
    },
    [focusRequest],
  )

  return (
    <div className={cx(styles['anchor'], className)} ref={root}>
      {trigger({
        open,
        props: {
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? id : undefined,
          onClick: () => {
            setFocusRequest(null)
            setOpen((current) => !current)
          },
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              setFocusRequest(event.key === 'ArrowDown' ? 'first' : 'last')
            }
          },
        },
      })}
      {open ? (
        <MenuContext.Provider value={{ close }}>
          <div
            aria-label={label}
            className={cx(
              styles['menu'],
              direction === 'up' ? styles['up'] : styles['down'],
              align === 'end' ? styles['end'] : styles['start'],
            )}
            id={id}
            onKeyDown={(event) => {
              const list = menu.current === null ? [] : items(menu.current)
              const index = list.indexOf(document.activeElement as HTMLElement)
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                list[(index + 1) % list.length]?.focus()
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                list[(index - 1 + list.length) % list.length]?.focus()
              } else if (event.key === 'Home') {
                event.preventDefault()
                list[0]?.focus()
              } else if (event.key === 'End') {
                event.preventDefault()
                list[list.length - 1]?.focus()
              } else if (event.key === 'Tab') {
                setOpen(false)
              }
            }}
            ref={attachMenu}
            role="menu"
            style={width === undefined ? undefined : { width }}
          >
            {children}
          </div>
        </MenuContext.Provider>
      ) : null}
    </div>
  )
}

export interface MenuItemProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onSelect'
> {
  onSelect: () => void
  danger?: boolean
  /** Keep the menu open after selecting. */
  keepOpen?: boolean
}

export function MenuItem({
  onSelect,
  danger = false,
  keepOpen = false,
  className,
  ...rest
}: MenuItemProps): React.JSX.Element {
  const context = useContext(MenuContext)
  return (
    <button
      {...rest}
      className={cx(styles['item'], danger && styles['danger'], className)}
      onClick={() => {
        if (!keepOpen) context?.close()
        onSelect()
      }}
      role="menuitem"
      type="button"
    />
  )
}

export function MenuSeparator(): React.JSX.Element {
  return <div className={styles['sep']} role="separator" />
}

export function MenuHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className={styles['head']}>{children}</div>
}
