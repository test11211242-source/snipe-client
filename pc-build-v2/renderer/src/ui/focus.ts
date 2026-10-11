import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const modalRoots: HTMLElement[] = []

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  )
}

/**
 * Modal focus handling: moves focus into `root` on open, keeps Tab inside, calls
 * `onEscape` on Esc and returns focus to the previously focused element on close.
 */
export function useModalFocus(
  root: RefObject<HTMLElement | null>,
  onEscape: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
): void {
  const escapeRef = useRef(onEscape)
  useEffect(() => {
    escapeRef.current = onEscape
  })

  useEffect(() => {
    const container = root.current
    if (container === null) return
    modalRoots.push(container)
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = initialFocus?.current ?? focusableIn(container)[0] ?? container
    first.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (modalRoots[modalRoots.length - 1] !== container) return
      const popup = document.querySelector<HTMLElement>('[role="menu"]')
      if (
        popup !== null &&
        container.querySelector(`[aria-controls="${popup.id}"]`) !== null &&
        (event.key === 'Escape' || popup.contains(event.target as Node))
      )
        return
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        escapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusableIn(container)
      if (items.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (firstItem === undefined || lastItem === undefined) return
      const active = document.activeElement
      if (event.shiftKey && (active === firstItem || !container.contains(active))) {
        event.preventDefault()
        lastItem.focus()
      } else if (
        !event.shiftKey &&
        (active === lastItem || !container.contains(active))
      ) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const index = modalRoots.indexOf(container)
      if (index >= 0) modalRoots.splice(index, 1)
      if (previous?.isConnected === true) previous.focus()
    }
  }, [root, initialFocus])
}

/** Calls `onDismiss` for a pointer press outside `root` and for Esc while focus is inside it. */
export function useDismiss(
  root: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
  also?: RefObject<HTMLElement | null>,
): void {
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  })
  useEffect(() => {
    if (!active) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (
        root.current !== null &&
        !root.current.contains(target) &&
        also?.current?.contains(target) !== true
      )
        dismissRef.current()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismissRef.current()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [root, also, active])
}
