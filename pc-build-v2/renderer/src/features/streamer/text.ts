import type { StreamerCommandResult } from '../../../../shared/contracts/streamer-ipc'
import type { PredictionSettings, StreamerView } from '../../../../shared/models/streamer'
import type { Tone } from '../../ui'

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
  PREDICTION_NO_BATTLE_TO_SKIP: 'Нет боя, который можно пропустить',
  STREAMER_COMMAND_FAILED: 'Не удалось выполнить действие. Повторите попытку.',
  TWITCH_OAUTH_URL_REJECTED:
    'Не удалось открыть страницу входа в Twitch: адрес не прошёл проверку. Повторите позже.',
  TWITCH_REQUIRED: 'Сначала подключите Twitch-канал.',
  CAPTURE_NOT_CONFIGURED: 'Сначала создайте и настройте профиль мониторинга.',
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

export type PredictionStatusView = Pick<
  StreamerView['predictions'],
  'enabled' | 'live' | 'clientReady' | 'phase' | 'attention' | 'prediction'
>

/** The only phrases the status pill may show (predictions plan §3.8). */
export const PREDICTION_PHRASES = {
  voting: 'Ставки открыты',
  locked: 'Ставки закрыты, ждём итог боя',
  unknown: 'Итог не распознан — выберите сами',
  settle: 'Есть ставки — закройте прогноз сами',
  waitingStream: 'Ждём начала трансляции',
  openMonitor: 'Откройте мониторинг',
  disabled: 'Прогнозы выключены',
  twitch: 'Twitch не отвечает',
  notEligible: 'Прогнозы недоступны для этого канала',
  reconnectTwitch: 'Переподключите Twitch',
  twitchPredictionExists: 'На Twitch уже идёт прогноз',
} as const

/** «Серия: k из N» for a streak prediction. */
export function streakProgress(wins: number, target: number): string {
  return `Серия: ${Math.min(wins, target)} из ${target}`
}

/**
 * The status pill of predictions. Only the fixed phrases of §3.8 are returned; server
 * phase and attention codes never reach the screen. `null` means there is nothing to say
 * (the next prediction is about to open).
 */
export function predictionStatusText(
  status: PredictionStatusView,
): { tone: Tone; label: string } | null {
  const { prediction, attention } = status
  if (prediction?.source === 'twitch')
    return { tone: 'warn', label: PREDICTION_PHRASES.twitchPredictionExists }
  switch (attention) {
    case 'channel_not_eligible':
      return { tone: 'danger', label: PREDICTION_PHRASES.notEligible }
    case 'twitch_unavailable':
      return { tone: 'danger', label: PREDICTION_PHRASES.twitch }
    case 'reconnect_twitch':
      return { tone: 'danger', label: PREDICTION_PHRASES.reconnectTwitch }
    case 'twitch_prediction_exists':
      return { tone: 'danger', label: PREDICTION_PHRASES.twitchPredictionExists }
    default:
      break
  }
  if (prediction !== null) {
    switch (attention) {
      case 'result_unknown':
      case 'result_missed':
        return { tone: 'warn', label: PREDICTION_PHRASES.unknown }
      case 'settle_after_disable':
        return { tone: 'warn', label: PREDICTION_PHRASES.settle }
      case 'stream_ended':
      case 'client_lost':
        return prediction.hasBets
          ? { tone: 'warn', label: PREDICTION_PHRASES.settle }
          : { tone: 'warn', label: PREDICTION_PHRASES.unknown }
      default:
        break
    }
    if (!status.clientReady)
      return { tone: 'warn', label: PREDICTION_PHRASES.openMonitor }
    if (!status.live) return { tone: 'neutral', label: PREDICTION_PHRASES.waitingStream }
    if (status.phase === 'voting') return { tone: 'ok', label: PREDICTION_PHRASES.voting }
    if (prediction.mode === 'streak')
      return { tone: 'ok', label: streakProgress(prediction.wins, prediction.target) }
    return { tone: 'neutral', label: PREDICTION_PHRASES.locked }
  }
  switch (status.phase) {
    case 'disabled':
      return { tone: 'neutral', label: PREDICTION_PHRASES.disabled }
    case 'client_not_ready':
      return { tone: 'warn', label: PREDICTION_PHRASES.openMonitor }
    case 'waiting_stream':
      return { tone: 'neutral', label: PREDICTION_PHRASES.waitingStream }
    default:
      return null
  }
}

export type VotingSeconds = PredictionSettings['votingSeconds']

/** «Время на ставки» choices (§3.3, O14). */
export const VOTING_CHOICES: readonly { value: VotingSeconds; label: string }[] = [
  { value: 30, label: '30 с' },
  { value: 45, label: '45 с' },
  { value: 60, label: '1 мин' },
  { value: 90, label: '1,5 мин' },
  { value: 120, label: '2 мин' },
  { value: 180, label: '3 мин' },
]

export function votingLabel(seconds: VotingSeconds): string {
  return VOTING_CHOICES.find((choice) => choice.value === seconds)?.label ?? ''
}
