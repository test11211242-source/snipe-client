import { useCallback, useEffect, useState } from 'react'

import type { UpdateView } from '../../../shared/models/update'

export type AuthUpdateCommand = 'download' | 'cancel' | 'install'

export interface AuthUpdater {
  view: UpdateView | null
  /** The update state could not be read or a command failed. */
  unavailable: boolean
  pending: AuthUpdateCommand | null
  run: (command: AuthUpdateCommand) => Promise<void>
}

/** Update state for the auth window: polled (faster while downloading), plus commands. */
export function useAuthUpdater(): AuthUpdater {
  const [view, setView] = useState<UpdateView | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [pending, setPending] = useState<AuthUpdateCommand | null>(null)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    const refresh = (): void => {
      window.crToolsAuth.getUpdateView().then(
        (next) => {
          if (!active) return
          setView(next)
          setUnavailable(false)
          timer = window.setTimeout(
            refresh,
            next.state === 'CHECKING' || next.state === 'DOWNLOADING' ? 1_000 : 5_000,
          )
        },
        () => {
          if (!active) return
          setUnavailable(true)
          timer = window.setTimeout(refresh, 5_000)
        },
      )
    }
    refresh()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [])

  const run = useCallback(async (command: AuthUpdateCommand): Promise<void> => {
    const call = {
      download: () => window.crToolsAuth.downloadUpdate(),
      cancel: () => window.crToolsAuth.cancelUpdate(),
      install: () => window.crToolsAuth.installUpdate(),
    }[command]
    setPending(command)
    try {
      const completion = call()
      if (command === 'download') {
        // The download call resolves only when it finishes; show progress meanwhile.
        void window.crToolsAuth.getUpdateView().then(setView, () => undefined)
      }
      setView(await completion)
      setUnavailable(false)
    } catch {
      setUnavailable(true)
    } finally {
      setPending(null)
    }
  }, [])

  return { view, unavailable, pending, run }
}
