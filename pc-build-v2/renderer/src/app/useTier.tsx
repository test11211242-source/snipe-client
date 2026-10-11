import { createContext, useContext, useEffect, useState, type RefObject } from 'react'

/** wide ≥ 1000, medium 720–999, mini < 720 — measured on the app container, not the screen. */
export type Tier = 'wide' | 'medium' | 'mini'

export function tierForWidth(width: number): Tier {
  return width >= 1000 ? 'wide' : width >= 720 ? 'medium' : 'mini'
}

const TierContext = createContext<Tier>('wide')
export const TierProvider = TierContext.Provider

export function useTier(): Tier {
  return useContext(TierContext)
}

/** Observes the width of `ref` (falls back to the window width without ResizeObserver). */
export function useContainerTier(ref: RefObject<HTMLElement | null>): Tier {
  const [tier, setTier] = useState<Tier>(() => tierForWidth(window.innerWidth))
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = (width: number): void => setTier(tierForWidth(width))
    if (typeof ResizeObserver === 'undefined') {
      const onResize = (): void => measure(window.innerWidth)
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width > 0) measure(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return tier
}
