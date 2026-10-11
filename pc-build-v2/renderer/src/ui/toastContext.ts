import { createContext, useContext } from 'react'

export interface ToastOptions {
  message: string
  /** "Отменить" style action; the toast closes after it runs. */
  action?: { label: string; onAction: () => void }
  /** Milliseconds, default 4000. */
  duration?: number
}

export interface ToastItem extends ToastOptions {
  id: number
}

export interface ToastApi {
  show: (options: ToastOptions) => void
  dismiss: (id?: number) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

/** Toasts report the outcome of a completed action. Errors belong in banners/dialogs. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast must be used inside ToastProvider')
  return api
}
