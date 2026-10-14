import type { WidgetResult, WidgetView } from '../../../shared/models/widget'

type FoundResult = Extract<WidgetResult, { kind: 'player_found' }>

export type OverlayTone = 'ok' | 'warn' | 'danger' | 'neutral'

export type OverlayBody =
  | { kind: 'found'; result: FoundResult }
  /** Request in flight: a nickname only when it was really read. */
  | { kind: 'searching'; nickname: string | null }
  | { kind: 'message'; title: string; text: string }

export interface OverlayModel {
  /** Status line of the top strip. */
  status: string
  tone: OverlayTone
  /** Spinner instead of the dot. */
  busy: boolean
  body: OverlayBody
}

const SOURCE_REBIND_CODE = 'SOURCE_REBIND_REQUIRED'

/**
 * What the overlay shows. Only the live widget result is used — the main window's history
 * selection never reaches this window.
 */
export function selectOverlayModel(view: WidgetView): OverlayModel {
  const { monitorState, runIntent, monitorError, search, result, sourceMinimized } = view
  if (monitorError?.code === SOURCE_REBIND_CODE)
    return {
      status: 'Нужна перенастройка',
      tone: 'warn',
      busy: false,
      body: { kind: 'message', title: 'Выберите окно игры', text: monitorError.message },
    }
  if (monitorState === 'WAITING_SOURCE' || (monitorState === 'FAILED' && runIntent))
    return {
      status: 'Ждём окно игры…',
      tone: 'warn',
      busy: false,
      body: {
        kind: 'message',
        title: 'Ждём окно игры',
        text: 'Как только окно появится, поиск продолжится сам.',
      },
    }
  if (monitorState === 'FAILED')
    return {
      status: 'Не запустился',
      tone: 'danger',
      busy: false,
      body: {
        kind: 'message',
        title: 'Мониторинг не запустился',
        text: monitorError?.message ?? 'Проверьте профиль в главном окне.',
      },
    }
  // Analysis is paused (main says «Окно игры закрыто или свёрнуто», too long for this
  // strip); a found deck stays useful.
  if (monitorState === 'READY' && sourceMinimized)
    return {
      status: 'Окно игры свёрнуто',
      tone: 'warn',
      busy: false,
      body:
        result?.kind === 'player_found'
          ? { kind: 'found', result }
          : {
              kind: 'message',
              title: 'Окно игры свёрнуто',
              text: 'Разверните его — поиск продолжится сам.',
            },
    }
  if (search?.phase === 'capturing' || search?.phase === 'requesting')
    return {
      status: 'Ищем соперника',
      tone: 'ok',
      busy: true,
      body: { kind: 'searching', nickname: search.searchedNickname },
    }
  if (result !== null) {
    switch (result.kind) {
      case 'player_found':
        return {
          status: 'Найден',
          tone: 'ok',
          busy: false,
          body: { kind: 'found', result },
        }
      case 'player_not_found':
        return {
          status: 'Нет в базе',
          tone: 'neutral',
          busy: false,
          body: {
            kind: 'message',
            title: result.searchedNickname ?? 'Игрока нет в базе',
            text: 'Такого игрока не нашли.',
          },
        }
      case 'recognition_failed':
        return {
          status: 'Ник не прочитан',
          tone: 'warn',
          busy: false,
          body: {
            kind: 'message',
            title: 'Не удалось прочитать ник',
            text: 'В следующем бою попробуем снова.',
          },
        }
      case 'service_error':
        return {
          status: 'Сбой сервиса',
          tone: 'danger',
          busy: false,
          body: {
            kind: 'message',
            title: 'Сервис поиска недоступен',
            text:
              result.searchedNickname === null
                ? 'Ник прочитан, но сервер не ответил.'
                : `Ник «${result.searchedNickname}» прочитан, но сервер не ответил.`,
          },
        }
    }
  }
  if (monitorState === 'STARTING' || monitorState === 'PREFLIGHT')
    return {
      status: 'Запускаем…',
      tone: 'neutral',
      busy: true,
      body: {
        kind: 'message',
        title: 'Запускаем мониторинг',
        text: 'Это займёт несколько секунд.',
      },
    }
  if (monitorState === 'STOPPING' || monitorState === 'STOPPED')
    return {
      status: 'Мониторинг остановлен',
      tone: 'neutral',
      busy: false,
      body: {
        kind: 'message',
        title: 'Мониторинг остановлен',
        text: 'Начните мониторинг в главном окне.',
      },
    }
  return {
    status: 'Ждём бой',
    tone: 'ok',
    busy: false,
    body: {
      kind: 'message',
      title: 'Ждём соперника',
      text: 'Оверлей обновится, когда начнётся бой.',
    },
  }
}
