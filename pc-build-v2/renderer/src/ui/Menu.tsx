import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import { cx } from './cx'
import { useDismiss } from './focus'
import { placeMenu } from './menuPlacement'
import styles from './Menu.module.css'

/** Distance from the trigger and the minimum distance to the viewport edge. */
const GAP = 8

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
  const place = useCallback(
    (element: HTMLElement): void => {
      const anchor = root.current
      if (anchor === null) return
      // Measure the natural size at the origin, then position inside the viewport.
      element.style.maxHeight = ''
      element.style.left = '0px'
      element.style.top = '0px'
      const size = element.getBoundingClientRect()
      const placement = placeMenu({
        anchor: anchor.getBoundingClientRect(),
        menu: { width: size.width, height: size.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        direction,
        align,
        gap: GAP,
        margin: GAP,
      })
      element.style.top = `${placement.top}px`
      element.style.left = `${placement.left}px`
      element.style.maxHeight =
        size.height > placement.maxHeight ? `${placement.maxHeight}px` : ''
      element.style.visibility = 'visible'
    },
    [align, direction],
  )
  useDismiss(
    root,
    open,
    () => {
      if (open) close()
    },
    menu,
  )

  // The menu is fixed-positioned in a portal so scroll containers never clip it.
  useEffect(() => {
    if (!open) return
    const reposition = (): void => {
      if (menu.current !== null) place(menu.current)
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, place])

  const attachMenu = useCallback(
    (element: HTMLDivElement | null): void => {
      menu.current = element
      if (element === null) return
      place(element)
      if (focusRequest === null) return
      const list = items(element)
      const target = focusRequest === 'first' ? list[0] : list[list.length - 1]
      target?.focus()
    },
    [focusRequest, place],
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
      {open
        ? createPortal(
            <MenuContext.Provider value={{ close }}>
              <div
                aria-label={label}
                className={styles['menu']}
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
                    event.preventDefault()
                    close()
                  }
                }}
                ref={attachMenu}
                role="menu"
                style={width === undefined ? undefined : { width }}
              >
                {children}
              </div>
            </MenuContext.Provider>,
            document.body,
          )
        : null}
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
