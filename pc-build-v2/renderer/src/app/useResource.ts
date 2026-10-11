import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BootstrapFailure } from '../../../shared/contracts/app'

export type ResourceName = BootstrapFailure['capability']

export interface ResourceError {
  code: BootstrapFailure['code']
  /** Fixed Russian text; raw error messages never reach the UI. */
  message: string
}

/**
 * One independently loaded piece of application state.
 * - `value` is the last good value and survives later failures.
 * - `error` is the latest failure (cleared by a successful load or a pushed value).
 */
export interface Resource<T> {
  value: T | null
  error: ResourceError | null
  /** A load is in flight (first load or reload). */
  loading: boolean
}

export interface ResourceController<T> extends Resource<T> {
  /** Reloads. `quiet` keeps the current error state on failure (background reconciliation). */
  reload: (options?: { quiet?: boolean }) => Promise<void>
  /** Applies a value from a push event or a command result and supersedes in-flight loads. */
  apply: (value: T) => void
  latest: () => T | null
}

const DEFAULT_MESSAGE = 'Не удалось получить данные.'

export function toResourceError(
  reason: unknown,
  message = DEFAULT_MESSAGE,
): ResourceError {
  return {
    code:
      reason instanceof Error && reason.message === 'INVALID_RESPONSE'
        ? 'INVALID_RESPONSE'
        : 'IPC_FAILED',
    message,
  }
}

/**
 * Generic resource controller. Loads once on mount, ignores stale responses (generation),
 * keeps the previous good value on failure and reports a first-load failure to main once
 * per attempt (capability + code only).
 */
export function useResource<T>(
  name: ResourceName,
  load: () => Promise<T>,
  message?: string,
  accepts?: (next: T, current: T) => boolean,
): ResourceController<T> {
  const [state, setState] = useState<Resource<T>>({
    value: null,
    error: null,
    loading: true,
  })
  const generation = useRef(0)
  const current = useRef<T | null>(null)
  const mounted = useRef(true)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  /** Fetches and applies the result; state changes only happen after the request settles. */
  const fetchInto = useCallback(
    (quiet: boolean): Promise<void> => {
      const mine = ++generation.current
      return loadRef.current().then(
        (value) => {
          if (mounted.current && mine === generation.current) {
            if (
              current.current === null ||
              accepts === undefined ||
              accepts(value, current.current)
            ) {
              current.current = value
              setState({ value, error: null, loading: false })
            } else setState((s) => ({ ...s, loading: false }))
          }
        },
        (reason: unknown) => {
          if (!mounted.current || mine !== generation.current) return
          const error = toResourceError(reason, message)
          setState((s) => {
            if (s.value === null)
              void window.crTools
                .reportBootstrapFailure({ capability: name, code: error.code })
                .catch(() => undefined)
            return quiet
              ? { ...s, loading: false }
              : { value: s.value, error, loading: false }
          })
        },
      )
    },
    [accepts, message, name],
  )

  const reload = useCallback(
    (options?: { quiet?: boolean }): Promise<void> => {
      const quiet = options?.quiet === true
      if (!quiet) setState((s) => ({ ...s, loading: true }))
      return fetchInto(quiet)
    },
    [fetchInto],
  )

  const apply = useCallback(
    (value: T): void => {
      if (
        current.current !== null &&
        accepts !== undefined &&
        !accepts(value, current.current)
      )
        return
      current.current = value
      generation.current += 1
      setState({ value, error: null, loading: false })
    },
    [accepts],
  )
  const latest = useCallback(() => current.current, [])

  useEffect(() => {
    mounted.current = true
    // First load: the state already says "loading".
    void fetchInto(false)
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [fetchInto])

  return useMemo(
    () => ({ ...state, reload, apply, latest }),
    [state, reload, apply, latest],
  )
}

/** Runs `tick` every `delay()` ms while mounted; pauses nothing, just reschedules. */
export function usePolling(tick: () => void, delay: () => number, enabled = true): void {
  const tickRef = useRef(tick)
  const delayRef = useRef(delay)
  useEffect(() => {
    tickRef.current = tick
    delayRef.current = delay
  })
  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        tickRef.current()
        schedule()
      }, delayRef.current())
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [enabled])
}
