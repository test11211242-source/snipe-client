import { useCallback, useEffect, useRef, useState } from 'react'

import type { WidgetSettingsPatch, WidgetStatus } from '../../../../shared/models/widget'
import { usePolling } from '../../app/useResource'

export interface WidgetSettingsController {
  status: WidgetStatus | null
  loading: boolean
  loadFailed: boolean
  /** A save or window toggle is running. */
  pending: boolean
  error: string | null
  reload: () => Promise<void>
  /** Saves immediately; the previous value stays visible if it fails. */
  update: (patch: WidgetSettingsPatch) => Promise<boolean>
  /** Shows or hides the overlay window. */
  toggleWindow: () => Promise<void>
}

/**
 * The overlay window's settings (the same fields as the tray menu and the window itself).
 * Saves are serialized; a quiet poll picks up changes made from the tray or the window.
 */
export function useWidgetSettings(): WidgetSettingsController {
  const [status, setStatus] = useState<WidgetStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const inFlight = useRef(0)

  const load = useCallback((quiet: boolean): Promise<void> => {
    const mine = ++generation.current
    return window.crTools.getWidgetStatus().then(
      (next) => {
        if (mine !== generation.current) return
        setStatus(next)
        setLoading(false)
        setLoadFailed(false)
      },
      () => {
        if (mine !== generation.current || quiet) return
        setLoading(false)
        setLoadFailed(true)
      },
    )
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load(false))
    return () => {
      generation.current += 1
    }
  }, [load])

  usePolling(
    () => {
      if (inFlight.current === 0 && !document.hidden) void load(true)
    },
    () => 5_000,
  )

  const enqueue = useCallback(<T>(job: () => Promise<T>): Promise<T | null> => {
    const run = async (): Promise<T | null> => {
      inFlight.current += 1
      setPending(true)
      setError(null)
      try {
        return await job()
      } catch {
        setError('Не удалось сохранить. Прежнее значение осталось.')
        return null
      } finally {
        inFlight.current -= 1
        if (inFlight.current === 0) setPending(false)
      }
    }
    const result = queue.current.then(run, run)
    queue.current = result
    return result
  }, [])

  const update = useCallback(
    async (patch: WidgetSettingsPatch): Promise<boolean> => {
      const next = await enqueue(() => window.crTools.updateWidgetSettings(patch))
      if (next === null) return false
      generation.current += 1
      setStatus((current) =>
        current === null ? current : { ...current, settings: next },
      )
      return true
    },
    [enqueue],
  )

  const toggleWindow = useCallback(async (): Promise<void> => {
    const next = await enqueue(() => window.crTools.toggleWidget())
    if (next === null) return
    generation.current += 1
    setStatus(next)
  }, [enqueue])

  return {
    status,
    loading,
    loadFailed,
    pending,
    error,
    reload: () => load(false),
    update,
    toggleWindow,
  }
}
