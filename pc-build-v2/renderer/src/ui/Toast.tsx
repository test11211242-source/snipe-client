import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { Button } from './Button'
import { Icon } from './Icon'
import styles from './Toast.module.css'
import { ToastContext, type ToastItem, type ToastOptions } from './toastContext'

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const counter = useRef(0)
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id?: number): void => {
    setItems((current) =>
      id === undefined ? [] : current.filter((item) => item.id !== id),
    )
    if (id === undefined) {
      timers.current.forEach((timer) => window.clearTimeout(timer))
      timers.current.clear()
    } else {
      const timer = timers.current.get(id)
      if (timer !== undefined) window.clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (options: ToastOptions): void => {
      counter.current += 1
      const id = counter.current
      setItems((current) => [...current.slice(-2), { ...options, id }])
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), options.duration ?? 4000),
      )
    },
    [dismiss],
  )

  useEffect(() => {
    const active = timers.current
    return () => {
      active.forEach((timer) => window.clearTimeout(timer))
      active.clear()
    }
  }, [])

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className={styles['viewport']} role="status">
        {items.map((item) => (
          <div className={styles['toast']} key={item.id}>
            <Icon name="checkCircle" size={16} />
            <span className={styles['text']}>{item.message}</span>
            {item.action === undefined ? null : (
              <Button
                onClick={() => {
                  item.action?.onAction()
                  dismiss(item.id)
                }}
                size="sm"
                variant="ghost"
              >
                {item.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
