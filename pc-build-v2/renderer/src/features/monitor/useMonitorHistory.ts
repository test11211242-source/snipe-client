import { useCallback, useEffect, useMemo, useState } from 'react'

import type { MonitorResult } from '../../../../shared/models/monitor'
import { HISTORY_PAGE_SIZE, mergeHistory } from './history'

export interface MonitorHistory {
  /** Live latest-20 merged with loaded older pages, newest first. */
  items: readonly MonitorResult[]
  loading: boolean
  /** The last page request failed (items stay). */
  error: boolean
  /** No older entries remain. */
  exhausted: boolean
  loadMore: () => void
  retry: () => void
}

function fetchPage(offset: number): Promise<MonitorResult[]> {
  return window.crTools.getMonitorHistory({ offset, limit: HISTORY_PAGE_SIZE })
}

/**
 * History list of the main screen: the pushed latest-20 plus older pages from
 * `getMonitorHistory` (journal, seven local days). A page is offset by what is already
 * shown, ids deduplicate pages that overlap pushed results.
 */
export function useMonitorHistory(live: readonly MonitorResult[]): MonitorHistory {
  const [older, setOlder] = useState<readonly MonitorResult[]>([])
  const [status, setStatus] = useState({ loading: true, error: false, exhausted: false })
  const items = useMemo(() => mergeHistory(live, older), [live, older])

  const accept = useCallback((page: readonly MonitorResult[]): void => {
    setOlder((current) => mergeHistory(current, page))
    setStatus({
      loading: false,
      error: false,
      exhausted: page.length < HISTORY_PAGE_SIZE,
    })
  }, [])
  const fail = useCallback((): void => {
    setStatus((current) => ({ ...current, loading: false, error: true }))
  }, [])

  useEffect(() => {
    let active = true
    void fetchPage(0).then(
      (page) => active && accept(page),
      () => active && fail(),
    )
    return () => {
      active = false
    }
  }, [accept, fail])

  const loadFrom = (offset: number): void => {
    setStatus((current) => ({ ...current, loading: true, error: false }))
    void fetchPage(offset).then(accept, fail)
  }
  const loadMore = (): void => {
    if (!status.loading && !status.exhausted) loadFrom(items.length)
  }
  const retry = (): void => {
    if (!status.loading) loadFrom(older.length === 0 ? 0 : items.length)
  }

  return { items, ...status, loadMore, retry }
}
