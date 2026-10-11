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
  const authoritative = useRef<WidgetStatus | null>(null)
  const drafts = useRef<WidgetSettingsPatch[]>([])
  const alive = useRef(true)
  const publish = useCallback(() => {
    const saved = authoritative.current
    if (!alive.current || saved === null) return
    const settings = { ...saved.settings }
    for (const patch of drafts.current) {
      Object.assign(
        settings,
        Object.fromEntries(
          Object.entries(patch).filter(
            ([key, value]) => key in settings && value !== undefined,
          ),
        ),
      )
    }
    setStatus({ ...saved, settings })
  }, [])

  const load = useCallback(
    (quiet: boolean): Promise<void> => {
      const mine = ++generation.current
      return window.crTools.getWidgetStatus().then(
        (next) => {
          if (mine !== generation.current) return
          authoritative.current = next
          publish()
          setLoading(false)
          setLoadFailed(false)
        },
        () => {
          if (mine !== generation.current || quiet) return
          setLoading(false)
          setLoadFailed(true)
        },
      )
    },
    [publish],
  )

  useEffect(() => {
    alive.current = true
    void Promise.resolve().then(() => load(false))
    return () => {
      alive.current = false
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
    inFlight.current += 1
    generation.current += 1
    setPending(true)
    setError(null)
    const run = async (): Promise<T | null> => {
      try {
        return await job()
      } catch {
        if (alive.current) setError('Не удалось сохранить. Прежнее значение осталось.')
        return null
      } finally {
        inFlight.current -= 1
        if (alive.current && inFlight.current === 0) setPending(false)
      }
    }
    const result = queue.current.then(run, run)
    queue.current = result
    return result
  }, [])

  const update = useCallback(
    async (patch: WidgetSettingsPatch): Promise<boolean> => {
      drafts.current.push(patch)
      publish()
      const next = await enqueue(() => window.crTools.updateWidgetSettings(patch))
      drafts.current.splice(drafts.current.indexOf(patch), 1)
      if (next !== null && authoritative.current !== null)
        authoritative.current = { ...authoritative.current, settings: next }
      generation.current += 1
      publish()
      return next !== null
    },
    [enqueue, publish],
  )

  const toggleWindow = useCallback(async (): Promise<void> => {
    const next = await enqueue(() => window.crTools.toggleWidget())
    if (next === null) return
    generation.current += 1
    authoritative.current = next
    publish()
  }, [enqueue, publish])

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
