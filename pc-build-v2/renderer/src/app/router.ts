import { createContext, useContext } from 'react'

export type StreamSection =
  'overview' | 'twitch' | 'predictions' | 'title' | 'chat' | 'widgets'
export type SettingsSection = 'app' | 'overlay' | 'accounts' | 'updates'

/** Why the full-window setup route was opened. */
export type SetupIntent =
  | { kind: 'new' }
  /** Re-pick the source of an existing profile and mark its regions again. */
  | {
      kind: 'recalibrate'
      profileId: string
      profileName: string
      expectedRevision: number
    }
  /** Only change the source binding of an existing profile. */
  | { kind: 'rebind'; profileId: string; profileName: string; expectedRevision: number }
  /** A setup session already exists in main (streamer link). */
  | { kind: 'resume' }

export type AppRoute =
  | { name: 'main' }
  | { name: 'setup'; intent?: SetupIntent | undefined }
  | { name: 'stream'; section: StreamSection }
  | { name: 'settings'; section: SettingsSection }

export const MAIN_ROUTE: AppRoute = { name: 'main' }

/** Routes only the streamer role may open. */
export function requiresStreamer(route: AppRoute): boolean {
  return route.name === 'stream'
}

export function routesEqual(a: AppRoute, b: AppRoute): boolean {
  if (a.name !== b.name) return false
  if (a.name === 'stream' && b.name === 'stream') return a.section === b.section
  if (a.name === 'settings' && b.name === 'settings') return a.section === b.section
  if (a.name === 'setup' && b.name === 'setup') {
    const left = a.intent ?? { kind: 'new' }
    const right = b.intent ?? { kind: 'new' }
    if (left.kind !== right.kind) return false
    return (
      !('profileId' in left && 'profileId' in right) ||
      (left.profileId === right.profileId &&
        left.expectedRevision === right.expectedRevision)
    )
  }
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
