import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { MAIN_ROUTE, RouterContext, routesEqual, type AppRoute } from './router'

/**
 * In-memory router. The monitor lives in main and in AppDataProvider above this
 * provider, so route changes never touch it.
 */
export function RouterProvider({
  initial = MAIN_ROUTE,
  children,
}: {
  initial?: AppRoute | undefined
  children: ReactNode
}): React.JSX.Element {
  const [stack, setStack] = useState<readonly AppRoute[]>([initial])
  const route = stack[stack.length - 1] ?? MAIN_ROUTE

  const navigate = useCallback((next: AppRoute): void => {
    setStack((current) => {
      const last = current[current.length - 1]
      if (last !== undefined && routesEqual(last, next)) return current
      return [...current.slice(-19), next]
    })
  }, [])
  const back = useCallback((fallback: AppRoute = MAIN_ROUTE): void => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : [fallback]))
  }, [])

  const value = useMemo(() => ({ route, navigate, back }), [route, navigate, back])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}
