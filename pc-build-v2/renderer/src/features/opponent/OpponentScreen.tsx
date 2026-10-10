import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import type { MonitorResult } from '../../../../shared/models/monitor'
import { useAppData } from '../../app/appData'
import { useMiniStripExtra } from '../../app/shell/slotsContext'
import { useTier } from '../../app/useTier'
import { Button, Icon } from '../../ui'
import { clockTime } from '../h2h/format'
import { searchInProgress, selectOpponentPresentation } from './model'
import { selectRunPhase, useMonitorView } from '../monitor'
import { useMonitorHistory } from '../monitor/useMonitorHistory'
import { useProfiles } from '../profiles'
import { OpponentPanel } from './OpponentPanel'
import styles from './Opponent.module.css'
import { HistoryList, SessionStats } from './SessionPanel'

const NO_RESULTS: readonly MonitorResult[] = []

/** Re-renders once when `iso` passes, so time-limited controls disappear on time. */
function useNowUntil(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (iso === null) return
    const delay = Date.parse(iso) - Date.now()
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, delay) + 50)
    return () => window.clearTimeout(timer)
  }, [iso])
  return now
}

/** The main screen: opponent card on the left, session counters and history on the right. */
export function OpponentScreen(): React.JSX.Element {
  const monitor = useMonitorView()
  const profiles = useProfiles()
  const { realtime } = useAppData()
  const tier = useTier()
  const miniExtra = useMiniStripExtra()
  const view = monitor.value
  const hasProfiles = (profiles.value?.profiles.length ?? 0) > 0
  const history = useMonitorHistory(view?.results ?? NO_RESULTS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dismissedSession, setDismissedSession] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const now = useNowUntil(view?.search?.retryExpiresAt ?? null)

  const selected =
    selectedId === null
      ? null
      : (history.items.find((item) => item.id === selectedId) ?? null)
  const latest = view?.results[0] ?? null
  const presentation = selectOpponentPresentation({
    view,
    hasProfiles,
    selected,
    latest,
    now,
    summaryDismissed: view?.summary?.sessionId === dismissedSession,
  })

  const offline =
    realtime.value !== null &&
    realtime.value.desiredConnected &&
    (realtime.value.state === 'BACKOFF' || realtime.value.state === 'DISCONNECTED')

  let viewing: { title: string; hint: string } | null = null
  if (presentation.kind === 'result' && presentation.viewing) {
    const result = presentation.result
    const name =
      result.kind === 'player_found'
        ? result.player.name
        : (result.searchedNickname ?? 'Ник не прочитан')
    const phase = selectRunPhase(view, hasProfiles)
    const hint =
      view !== null &&
      searchInProgress({
        view,
        hasProfiles,
        selected,
        latest,
        now,
        summaryDismissed: false,
      })
        ? 'идёт поиск соперника'
        : latest !== null && latest.id !== result.id && phase === 'running'
          ? 'есть новый результат'
          : phase === 'running'
            ? 'бой сейчас не идёт'
            : 'мониторинг остановлен'
    viewing = { title: `${name}, ${clockTime(result.timestamp)}`, hint }
  }

  const retry =
    presentation.kind === 'result' && presentation.retry !== null
      ? {
          pending: retrying,
          onRetry: () => {
            const attemptId = presentation.retry?.attemptId
            if (attemptId === undefined) return
            setRetrying(true)
            void monitor.retrySearch(attemptId).finally(() => setRetrying(false))
          },
        }
      : null

  const select = (id: string): void => {
    setSelectedId(id)
    setSheetOpen(false)
  }
  const stats = view?.stats ?? null
  const historyList = (
    <HistoryList
      history={history}
      historyError={view?.historyError ?? null}
      onSelect={select}
      selectedId={selected?.id ?? null}
    />
  )

  return (
    <div className={styles['screen']}>
      <OpponentPanel
        deckMode={view?.preferences.deckMode ?? 'pol'}
        monitor={monitor}
        offlineAttempt={
          offline ? Math.max(1, realtime.value?.reconnectAttempt ?? 1) : null
        }
        onBackToCurrent={() => setSelectedId(null)}
        onCloseSummary={() => setDismissedSession(view?.summary?.sessionId ?? null)}
        presentation={presentation}
        retry={retry}
        viewing={viewing}
      />
      {tier === 'mini' ? (
        miniExtra === null ? null : (
          createPortal(
            <>
              <Button
                aria-expanded={sheetOpen}
                onClick={() => setSheetOpen((open) => !open)}
              >
                <Icon name="history" size={14} />
                История
                <Icon name={sheetOpen ? 'chevronDown' : 'chevronUp'} size={14} />
              </Button>
              {sheetOpen ? (
                <div className={styles['sheet']}>
                  {stats === null ? null : <SessionStats stats={stats} />}
                  {historyList}
                </div>
              ) : null}
            </>,
            miniExtra,
          )
        )
      ) : (
        <aside className={styles['side']}>
          {stats === null ? null : <SessionStats stats={stats} />}
          {historyList}
        </aside>
      )}
    </div>
  )
}
