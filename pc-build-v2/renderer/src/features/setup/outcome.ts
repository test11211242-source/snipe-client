import type { SetupSessionView } from '../../../../shared/models/setup'
import type { Tone } from '../../ui'

export interface OutcomeLine {
  id: 'local' | 'projection' | 'runtime'
  title: string
  value: string
  tone: Tone
}

export interface OutcomeDescription {
  /** `ok` all good, `warn` saved but something needs attention, `danger` not saved. */
  tone: 'ok' | 'warn' | 'danger'
  title: string
  text: string
  lines: OutcomeLine[]
  /** «Повторить отправку» makes sense: saved locally, the server did not get it. */
  canRetrySync: boolean
  /** Notes under the summary, one per issue main reports. */
  notes: { title: string; text: string }[]
}

/**
 * What a finished save really did. `COMMITTED` only means saved on this computer;
 * server synchronization and the monitor restart are reported independently.
 */
export function describeOutcome(view: SetupSessionView): OutcomeDescription {
  const outcome = view.saveOutcome
  const result = view.kind === 'predictionResult'
  const staleSync = view.error?.code === 'CAPTURE_PROFILE_STALE'

  if (outcome === null)
    return {
      tone: 'ok',
      title: result ? 'Зоны результата сохранены' : 'Профиль сохранён',
      text: 'Приложение подтвердило сохранение на этом компьютере.',
      lines: [],
      canRetrySync: false,
      notes: [],
    }

  const lines: OutcomeLine[] = [
    outcome.local === 'saved'
      ? { id: 'local', title: 'На этом компьютере', value: 'сохранено', tone: 'ok' }
      : {
          id: 'local',
          title: 'На этом компьютере',
          value: 'не сохранено',
          tone: 'danger',
        },
    projectionLine(outcome.projection),
    runtimeLine(outcome.runtime),
  ]
  const notes: { title: string; text: string }[] = []
  const canRetrySync =
    outcome.local === 'saved' && outcome.projection === 'failed' && !staleSync
  if (outcome.projection === 'failed')
    notes.push(
      staleSync
        ? {
            title: 'Отправку повторить нельзя',
            text: 'Сохранённая настройка уже изменилась, поэтому старую отправлять не нужно.',
          }
        : {
            title: 'Сервер не получил настройку',
            text: 'Она сохранена на этом компьютере. Повторите отправку — сохранять заново не нужно.',
          },
    )
  if (outcome.runtime === 'failed')
    notes.push({
      title: 'Мониторинг не запустился',
      text: 'Запустите его вручную на главном экране.',
    })
  if (outcome.runtime === 'waiting_source')
    notes.push({
      title: 'Мониторинг ждёт окно игры',
      text: 'Он продолжит, когда окно появится.',
    })

  if (outcome.local === 'failed')
    return {
      tone: 'danger',
      title: result ? 'Зоны результата не сохранены' : 'Профиль не сохранён',
      text: 'Настройка не сохранена на этом компьютере; серверные данные не изменились.',
      lines,
      canRetrySync: false,
      notes,
    }
  const clean =
    outcome.projection !== 'failed' &&
    outcome.runtime !== 'failed' &&
    outcome.runtime !== 'waiting_source'
  return {
    tone: clean ? 'ok' : 'warn',
    title: clean
      ? result
        ? 'Зоны результата сохранены'
        : 'Профиль сохранён'
      : result
        ? 'Зоны результата сохранены на этом компьютере'
        : 'Профиль сохранён на этом компьютере',
    text: clean
      ? 'Сохранение завершено без ошибок.'
      : 'Сохранение прошло, но не всё завершилось. Подробности ниже.',
    lines,
    canRetrySync,
    notes,
  }
}

function projectionLine(
  value: 'synced' | 'failed' | 'not_required' | 'not_attempted',
): OutcomeLine {
  switch (value) {
    case 'synced':
      return { id: 'projection', title: 'Сервер', value: 'синхронизировано', tone: 'ok' }
    case 'failed':
      return { id: 'projection', title: 'Сервер', value: 'не отправлено', tone: 'warn' }
    case 'not_required':
      return { id: 'projection', title: 'Сервер', value: 'не требуется', tone: 'neutral' }
    case 'not_attempted':
      return {
        id: 'projection',
        title: 'Сервер',
        value: 'ещё не отправлялось',
        tone: 'neutral',
      }
  }
}

function runtimeLine(
  value: 'ready' | 'waiting_source' | 'failed' | 'not_requested',
): OutcomeLine {
  switch (value) {
    case 'ready':
      return { id: 'runtime', title: 'Мониторинг', value: 'готов к работе', tone: 'ok' }
    case 'waiting_source':
      return { id: 'runtime', title: 'Мониторинг', value: 'ждёт окно игры', tone: 'warn' }
    case 'failed':
      return { id: 'runtime', title: 'Мониторинг', value: 'не запустился', tone: 'warn' }
    case 'not_requested':
      return { id: 'runtime', title: 'Мониторинг', value: 'не затронут', tone: 'neutral' }
  }
}
