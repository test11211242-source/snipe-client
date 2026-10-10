import type { MonitorView } from '../../../../shared/models/monitor'
import type { RealtimeStatus } from '../../../../shared/models/network'
import type { Tone } from '../../ui'

export type RunPhase =
  | 'no-profile'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'waiting-source'
  | 'stopping'
  | 'failed'

/**
 * Presentation phase of the Start/Stop control, derived from the main-owned view.
 * `runIntent` and `state` are separate: WAITING_SOURCE is still "running" with Stop.
 */
export function selectRunPhase(view: MonitorView | null, hasProfiles: boolean): RunPhase {
  if (!hasProfiles) return 'no-profile'
  if (view === null) return 'stopped'
  switch (view.state) {
    case 'PREFLIGHT':
    case 'STARTING':
      return 'starting'
    case 'READY':
      return 'running'
    case 'WAITING_SOURCE':
      return 'waiting-source'
    case 'STOPPING':
      return 'stopping'
    case 'FAILED':
      return view.runIntent ? 'waiting-source' : 'failed'
    case 'STOPPED':
      return 'stopped'
  }
}

export interface MonitorStatusPresentation {
  text: string
  tone: Tone
  /** Pulsing dot: monitoring is alive. */
  live: boolean
  /** Spinner instead of the dot. */
  busy: boolean
  /** Elapsed time next to the text while monitoring runs. */
  showElapsed: boolean
}

/** Status line of the command bar. Reconnect state wins over a calm monitor state. */
export function selectStatus(
  view: MonitorView | null,
  hasProfiles: boolean,
  realtime: RealtimeStatus | null,
): MonitorStatusPresentation {
  const phase = selectRunPhase(view, hasProfiles)
  const status = (
    text: string,
    tone: Tone = 'neutral',
    extra: Partial<MonitorStatusPresentation> = {},
  ): MonitorStatusPresentation => ({
    text,
    tone,
    live: false,
    busy: false,
    showElapsed: false,
    ...extra,
  })
  const offline =
    realtime !== null &&
    realtime.desiredConnected &&
    (realtime.state === 'BACKOFF' || realtime.state === 'DISCONNECTED')

  switch (phase) {
    case 'no-profile':
      return status('Профиль не создан')
    case 'stopped':
      return status('Остановлено')
    case 'starting':
      return status('Запускаем мониторинг…', 'neutral', { busy: true })
    case 'stopping':
      return status('Останавливаем…', 'neutral', { busy: true })
    case 'failed':
      return status('Не удалось запустить', 'danger')
    case 'waiting-source':
      return status('Ждём окно игры…', 'warn')
    case 'running': {
      if (offline) return status('Нет связи с сервером', 'warn')
      const latest = view?.results[0] ?? null
      if (view?.search != null && ['capturing', 'requesting'].includes(view.search.phase))
        return status('Ищем соперника…', 'ok', { live: true, showElapsed: true })
      if (latest?.kind === 'service_error' && latest.authBlocked)
        return status('Нужно войти заново', 'danger')
      if (latest?.kind === 'service_error') return status('Сервис недоступен', 'warn')
      if (latest === null)
        return status('Ждём бой', 'ok', { live: true, showElapsed: true })
      if (latest.kind === 'player_found')
        return status('Идёт мониторинг', 'ok', { live: true, showElapsed: true })
      return status('Ждём следующий бой', 'ok', { live: true, showElapsed: true })
    }
  }
}

/** mm:ss (hh:mm:ss from one hour). */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`
}
