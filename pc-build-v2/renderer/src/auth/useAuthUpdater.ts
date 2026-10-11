import { useCallback, useEffect, useRef, useState } from 'react'

import type { UpdateView } from '../../../shared/models/update'

export type AuthUpdateCommand = 'download' | 'cancel' | 'install'

export interface AuthUpdater {
  view: UpdateView | null
  /** The update state could not be read or a command failed. */
  unavailable: boolean
  pending: AuthUpdateCommand | null
  run: (command: AuthUpdateCommand) => Promise<void>
}

/** Commands fence older polls; cancellation may supersede an in-flight download. */
export function useAuthUpdater(): AuthUpdater {
  const [view, setView] = useState<UpdateView | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [pending, setPending] = useState<AuthUpdateCommand | null>(null)
  const operation = useRef(0)
  const epoch = useRef(0)
  const busy = useRef<AuthUpdateCommand | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let active = true
    let timer: number | undefined
    const refresh = (): void => {
      const mine = epoch.current
      window.crToolsAuth.getUpdateView().then(
        (next) => {
          if (!active) return
          if (mine === epoch.current) {
            setView(next)
            setUnavailable(false)
          }
          timer = window.setTimeout(
            refresh,
            next.state === 'CHECKING' || next.state === 'DOWNLOADING' ? 1_000 : 5_000,
          )
        },
        () => {
          if (!active) return
          if (mine === epoch.current) setUnavailable(true)
          timer = window.setTimeout(refresh, 5_000)
        },
      )
    }
    refresh()
    return () => {
      alive.current = false
      operation.current += 1
      active = false
      epoch.current += 1
      window.clearTimeout(timer)
    }
  }, [])

  const run = useCallback(async (command: AuthUpdateCommand): Promise<void> => {
    if (busy.current !== null && !(busy.current === 'download' && command === 'cancel'))
      return
    const mine = ++operation.current
    const pollEpoch = ++epoch.current
    busy.current = command
    setPending(command)
    const call = {
      download: () => window.crToolsAuth.downloadUpdate(),
      cancel: () => window.crToolsAuth.cancelUpdate(),
      install: () => window.crToolsAuth.installUpdate(),
    }[command]
    try {
      const completion = call()
      if (command === 'download') {
        void window.crToolsAuth.getUpdateView().then(
          (next) => {
            if (
              alive.current &&
              mine === operation.current &&
              pollEpoch === epoch.current
            )
              setView(next)
          },
          () => undefined,
        )
      }
      const next = await completion
      if (!alive.current || mine !== operation.current) return
      epoch.current += 1
      setView(next)
      setUnavailable(false)
    } catch {
      if (alive.current && mine === operation.current) {
        epoch.current += 1
        setUnavailable(true)
      }
    } finally {
      if (mine === operation.current) {
        busy.current = null
        if (alive.current) setPending(null)
      }
    }
  }, [])

  return { view, unavailable, pending, run }
}
