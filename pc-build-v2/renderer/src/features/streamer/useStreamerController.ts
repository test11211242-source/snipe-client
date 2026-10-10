import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  StreamerCommand,
  StreamerCommandResult,
  StreamerReadiness,
} from '../../../../shared/contracts/streamer-ipc'
import type { StreamerView } from '../../../../shared/models/streamer'
import { usePolling } from '../../app/useResource'
import type { StreamerFailureCode } from './text'

export type CommandSuccess = Extract<StreamerCommandResult, { ok: true }>

/** What a caller learns about its command. Drafts stay with the caller on `failed`. */
export type CommandOutcome =
  | { status: 'ok'; result: CommandSuccess }
  | { status: 'failed'; code: StreamerFailureCode; detail: string | null }
  /** A newer command with the same key replaced this one before it started. */
  | { status: 'superseded' }

export interface CommandOptions {
  /**
   * Waiting commands with the same key collapse into the newest one (typing in a field,
   * repeated toggles). A command already in flight is never interrupted.
   */
  key?: string
}

export interface StreamerController {
  view: StreamerView | null
  readiness: StreamerReadiness | null
  /** First load is in flight. */
  loading: boolean
  /** First load failed and there is no view to show. */
  loadFailed: boolean
  /** Commands queued or running. */
  pendingKeys: ReadonlySet<string>
  busy: boolean
  reload: () => Promise<void>
  command: (command: StreamerCommand, options?: CommandOptions) => Promise<CommandOutcome>
}

interface QueueItem {
  command: StreamerCommand
  key: string
  resolve: (outcome: CommandOutcome) => void
}

const POLL_MS = 5_000

/**
 * The streamer area's data. One instance per mounted area: it opens the main-process
 * streamer section while mounted, polls the view and readiness, and funnels every
 * mutation through `streamer.command` one at a time. Poll results that started before a
 * command finished are dropped, so a stale view never overwrites a fresh one.
 */
export function useStreamerController(enabled: boolean): StreamerController {
  const [view, setView] = useState<StreamerView | null>(null)
  const [readiness, setReadiness] = useState<StreamerReadiness | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())

  const generation = useRef(0)
  const mounted = useRef(true)
  const queue = useRef<QueueItem[]>([])
  const running = useRef(false)
  const counter = useRef(0)
  /** The request that started at generation `mine` no longer matters (unmounted or superseded). */
  const isStale = useCallback(
    (mine: number): boolean => !mounted.current || mine !== generation.current,
    [],
  )

  const loadReadiness = useCallback((): Promise<void> => {
    const mine = generation.current
    return window.crTools.streamer.getReadiness().then(
      (value) => {
        if (!isStale(mine)) setReadiness(value)
      },
      () => undefined,
    )
  }, [isStale])

  /** Reads the current view (and readiness). Stale answers are discarded. */
  const poll = useCallback(async (): Promise<void> => {
    if (running.current || queue.current.length > 0) return
    const mine = generation.current
    try {
      const next = await window.crTools.getStreamerView()
      if (!isStale(mine)) setView(next)
    } catch {
      // The last good view stays; the explicit reload reports first-load failures.
    }
    await loadReadiness()
  }, [isStale, loadReadiness])

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const opened = await window.crTools.setStreamerSectionActive(true)
      if (isStale(mine)) return
      setView(opened)
      setLoading(false)
      try {
        const refreshed = await window.crTools.refreshStreamer()
        if (!isStale(mine)) setView(refreshed)
      } catch {
        // Partial data: the view's own refresh errors describe what is missing.
      }
      await loadReadiness()
    } catch {
      if (!isStale(mine)) {
        setLoading(false)
        setLoadFailed(true)
      }
    }
  }, [isStale, loadReadiness])

  useEffect(() => {
    mounted.current = true
    if (!enabled) return
    void Promise.resolve().then(reload)
    const waiting = queue.current
    return () => {
      mounted.current = false
      generation.current += 1
      for (const item of waiting.splice(0)) item.resolve({ status: 'superseded' })
      void window.crTools.setStreamerSectionActive(false).catch(() => undefined)
    }
  }, [enabled, reload])

  usePolling(
    () => {
      if (!document.hidden) void poll()
    },
    () => POLL_MS,
    enabled,
  )

  const execute = useCallback(
    async (command: StreamerCommand): Promise<CommandOutcome> => {
      try {
        const result = await window.crTools.streamer.command(command)
        if (!result.ok)
          return {
            status: 'failed',
            code: result.error.code,
            detail: result.error.detail,
          }
        generation.current += 1
        if (mounted.current) setView(result.view)
        void loadReadiness()
        return { status: 'ok', result }
      } catch {
        return { status: 'failed', code: 'IPC_FAILED', detail: null }
      }
    },
    [loadReadiness],
  )

  const syncPending = useCallback((): void => {
    if (mounted.current) setPendingKeys(new Set(queue.current.map((item) => item.key)))
  }, [])

  const drain = useCallback(async (): Promise<void> => {
    if (running.current) return
    running.current = true
    try {
      for (;;) {
        const item = queue.current[0]
        if (item === undefined) break
        // Stays in the queue (and in pendingKeys) while it runs.
        const outcome = await execute(item.command)
        queue.current.shift()
        syncPending()
        item.resolve(outcome)
      }
    } finally {
      running.current = false
    }
  }, [execute, syncPending])

  const command = useCallback(
    (next: StreamerCommand, options?: CommandOptions): Promise<CommandOutcome> =>
      new Promise<CommandOutcome>((resolve) => {
        const key = options?.key ?? `${next.action}#${++counter.current}`
        // Collapse a waiting (not yet running) command with the same key.
        const startIndex = running.current ? 1 : 0
        for (let index = queue.current.length - 1; index >= startIndex; index -= 1) {
          const waiting = queue.current[index]
          if (waiting?.key === key) {
            waiting.resolve({ status: 'superseded' })
            queue.current.splice(index, 1)
          }
        }
        queue.current.push({ command: next, key, resolve })
        syncPending()
        void drain()
      }),
    [drain, syncPending],
  )

  return useMemo(
    () => ({
      view,
      readiness,
      loading,
      loadFailed,
      pendingKeys,
      busy: pendingKeys.size > 0,
      reload,
      command,
    }),
    [view, readiness, loading, loadFailed, pendingKeys, reload, command],
  )
}
