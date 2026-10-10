import { createContext, useContext } from 'react'

export type StreamSection =
  'overview' | 'twitch' | 'predictions' | 'title' | 'chat' | 'widgets'
export type SettingsSection = 'app' | 'overlay' | 'accounts' | 'updates'
/** Old (pre-V2) screens still reachable through temporary links until M3–M5 replace them. */
export type LegacyPage = 'home' | 'capture' | 'streamer' | 'settings' | 'setup'

export type AppRoute =
  | { name: 'main' }
  | { name: 'setup' }
  | { name: 'stream'; section: StreamSection }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'legacy'; page: LegacyPage }

export const MAIN_ROUTE: AppRoute = { name: 'main' }

/** Routes only the streamer role may open. */
export function requiresStreamer(route: AppRoute): boolean {
  return route.name === 'stream'
}

export function routesEqual(a: AppRoute, b: AppRoute): boolean {
  if (a.name !== b.name) return false
  if (a.name === 'stream' && b.name === 'stream') return a.section === b.section
  if (a.name === 'settings' && b.name === 'settings') return a.section === b.section
  if (a.name === 'legacy' && b.name === 'legacy') return a.page === b.page
  return true
}

export interface RouterApi {
  route: AppRoute
  navigate: (route: AppRoute) => void
  /** Returns to the previous destination (setup close), or `fallback` when there is none. */
  back: (fallback?: AppRoute) => void
}

export const RouterContext = createContext<RouterApi | null>(null)

export function useRouter(): RouterApi {
  const router = useContext(RouterContext)
  if (router === null) throw new Error('useRouter must be used inside RouterProvider')
  return router
}
