import type { StreamerCommandResult } from '../../../../shared/contracts/streamer-ipc'

export type CommandErrorCode = Extract<
  StreamerCommandResult,
  { ok: false }
>['error']['code']
export type CommandWarning = Extract<
  StreamerCommandResult,
  { ok: true }
>['warnings'][number]
export type TitleApplication = Extract<
  StreamerCommandResult,
  { ok: true }
>['titleApplication']

/** Failure reported by the streamer controller; `IPC_FAILED` is a rejected bridge call. */
export type StreamerFailureCode = CommandErrorCode | 'IPC_FAILED'

const COMMAND_ERRORS: Record<StreamerFailureCode, string> = {
  ACCOUNT_TAG_INVALID:
    'Тег записан неверно. В нём только цифры и буквы 0 2 8 9 P Y L Q G R J C U V — проверьте, нет ли лишних символов.',
  ACCOUNT_NOT_FOUND:
    'Такого игрока нет в Clash Royale. Проверьте тег в игре: профиль → под ником.',
  ACCOUNT_LIMIT_REACHED:
    'Достигнут предел — 20 аккаунтов. Удалите ненужный, чтобы добавить новый.',
  CLASH_API_UNAVAILABLE:
    'Сервер Clash Royale сейчас не отвечает, тег проверить не удалось. Попробуйте через минуту — введённые данные сохранены.',
  ACCOUNT_SAVE_UNAVAILABLE:
    'Сервер не смог сохранить аккаунт. Это не ваша вина — повторите через пару минут.',
  UNAUTHORIZED: 'Сеанс закончился. Войдите в аккаунт заново и повторите действие.',
  FORBIDDEN: 'Сервер не разрешил это действие для вашей учётной записи.',
  STREAMER_ROLE_REQUIRED: 'Управление эфиром доступно только роли «Стример».',
  STREAMER_CANCELLED: 'Действие отменено, пока вы переключали аккаунт. Повторите его.',
  UNKNOWN: 'Не удалось выполнить действие. Повторите попытку.',
  VALIDATION_FAILED: 'Сервер не принял эти значения. Проверьте поля и повторите.',
  NETWORK_UNAVAILABLE:
    'Нет связи с сервером. Проверьте интернет и повторите — введённые данные сохранены.',
  REQUEST_TIMEOUT: 'Сервер слишком долго отвечает. Подождите минуту и повторите.',
  SERVER_ERROR: 'На сервере что-то пошло не так. Повторите через пару минут.',
  INVALID_RESPONSE: 'Сервер ответил неожиданно. Повторите через минуту.',
  STREAMER_COMMAND_FAILED: 'Не удалось выполнить действие. Повторите попытку.',
  TWITCH_OAUTH_URL_REJECTED:
    'Не удалось открыть страницу входа в Twitch: адрес не прошёл проверку. Повторите позже.',
  TWITCH_REQUIRED: 'Сначала подключите Twitch-канал.',
  RESULT_SETUP_REQUIRED: 'Сначала настройте зоны результата в профиле.',
  CAPTURE_NOT_CONFIGURED: 'Сначала создайте и настройте профиль мониторинга.',
  PREDICTION_CANCELLED: 'Запуск прогнозов отменён. Повторите, когда будете готовы.',
  PREDICTION_AUTH_CHANGED: 'Аккаунт изменился во время запуска. Повторите действие.',
  PREDICTION_START_FAILED: 'Не удалось включить прогнозы. Ничего не изменилось.',
  PREDICTION_LOCAL_START_FAILED:
    'Прогнозы не запустились на этом компьютере. Проверьте мониторинг и повторите.',
  PREDICTION_ROLLBACK_UNKNOWN:
    'Прогнозы остановились с ошибкой, и состояние неизвестно. Обновите страницу и проверьте.',
  PREDICTION_ALREADY_ACTIVE: 'Прогнозы уже идут. Выключите их, чтобы изменить параметры.',
  PREDICTION_STOP_UNKNOWN:
    'Не удалось подтвердить остановку прогнозов. Обновите страницу и проверьте.',
  PREDICTION_MONITOR_RESTART_FAILED:
    'Прогнозы выключены, но мониторинг не перезапустился. Запустите его кнопкой сверху.',
  OVERLAY_URL_UNAVAILABLE:
    'Сервер ещё не выдал ссылку для OBS. Нажмите «Обновить» или попробуйте через минуту.',
  TITLE_ACCOUNT_SELECTION_CONFLICT:
    'Нельзя одновременно показывать «Ник аккаунта» и «Лучший аккаунт».',
  TITLE_APPLY_UNAVAILABLE:
    'Сейчас название применить нельзя: подключите Twitch и включите хотя бы один аккаунт.',
  IPC_FAILED: 'Приложение не ответило. Повторите действие.',
}

export function describeCommandError(code: StreamerFailureCode): string {
  return COMMAND_ERRORS[code]
}

const WARNINGS: Record<CommandWarning, string> = {
  TITLE_UPDATE_FAILED:
    'Сохранено, но Twitch не принял название. Оно обновится, когда канал станет доступен, — или повторите «Применить».',
  REFRESH_FAILED: 'Изменение сохранено, но часть данных не обновилась.',
  TITLE_APPLICATION_UNCONFIRMED: 'Отправлено, Twitch не подтвердил.',
}

export function describeWarning(warning: CommandWarning): string {
  return WARNINGS[warning]
}

/**
 * What to tell the user after a title mutation. Never claims the title was updated on
 * Twitch: the server has no receipt, so the strongest honest wording is «Отправлено».
 */
export function titleApplicationText(
  application: TitleApplication,
  warnings: readonly CommandWarning[],
): { tone: 'ok' | 'warn'; text: string } | null {
  if (application === 'failed' || warnings.includes('TITLE_UPDATE_FAILED'))
    return { tone: 'warn', text: WARNINGS.TITLE_UPDATE_FAILED }
  if (application === 'unconfirmed' || warnings.includes('TITLE_APPLICATION_UNCONFIRMED'))
    return { tone: 'ok', text: 'Отправлено, Twitch не подтвердил' }
  return null
}

export const REFRESH_SECTION_LABELS: Record<string, string> = {
  twitch: 'Twitch',
  predictions: 'прогнозы',
  title: 'название стрима',
  deckSharing: 'колоды в чат',
  overlay: 'виджеты OBS',
}
