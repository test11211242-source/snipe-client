import type { MonitorResult } from '../../../../shared/models/monitor'

/** Page size of "Показать ещё" and of the first history load. */
export const HISTORY_PAGE_SIZE = 20

/** Live latest-20 first, then older pages; unique by result id, newest first. */
export function mergeHistory(
  live: readonly MonitorResult[],
  older: readonly MonitorResult[],
): MonitorResult[] {
  const seen = new Set<string>()
  const merged: MonitorResult[] = []
  for (const result of [...live, ...older]) {
    if (seen.has(result.id)) continue
    seen.add(result.id)
    merged.push(result)
  }
  return merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}

export interface HistoryRowModel {
  icon: 'check' | 'search' | 'scan' | 'alert'
  tone: 'ok' | 'neutral' | 'warn' | 'danger'
  title: string
  /** Rating/clan or a short reason. */
  rating: number | null
  detail: string
  /** Same canonical tag already met today: only from the structured `repeat` field. */
  repeated: boolean
  reprocessed: boolean
}

/** One-line presentation of a history entry, shared by the list and a11y labels. */
export function describeResult(result: MonitorResult): HistoryRowModel {
  const base = { repeated: result.repeat !== null, reprocessed: result.reprocessed }
  switch (result.kind) {
    case 'player_found':
      return {
        ...base,
        icon: 'check',
        tone: 'ok',
        title: result.player.name,
        rating: result.player.rating,
        detail: result.player.clan ?? 'Без клана',
      }
    case 'player_not_found':
      return {
        ...base,
        icon: 'search',
        tone: 'neutral',
        title: result.searchedNickname ?? 'Нет в базе',
        rating: null,
        detail: 'нет в базе',
      }
    case 'recognition_failed':
      return {
        ...base,
        icon: 'scan',
        tone: 'warn',
        title: 'Ник не прочитан',
        rating: null,
        detail: 'не удалось распознать',
      }
    case 'service_error':
      return {
        ...base,
        icon: 'alert',
        tone: 'danger',
        title: result.searchedNickname ?? 'Сбой сервиса',
        rating: null,
        detail: result.authBlocked ? 'нужен вход' : 'сервис недоступен',
      }
  }
}
