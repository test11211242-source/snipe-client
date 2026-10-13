/** Russian wording for setup failures. Raw error messages never reach the UI. */

export function preparationFailureMessage(code: string): string {
  switch (code) {
    case 'RUNTIME_INTEGRITY_FAILED':
      return 'Компоненты локального мониторинга повреждены. Обновите или переустановите приложение.'
    case 'CAPTURE_PREPARATION_TIMEOUT':
      return 'Захват не запустился за 8 секунд. Убедитесь, что источник доступен и не свёрнут, затем повторите выбор.'
    case 'CAPTURE_PREPARATION_START_FAILED':
    case 'CAPTURE_PREPARATION_EXITED':
      return 'Служба захвата не запустилась. Повторите выбор источника.'
    case 'DISPLAY_MAPPING_UNSUPPORTED':
      return 'Выбранный монитор нельзя безопасно сопоставить с устройством Windows.'
    case 'CAPTURE_PREPARATION_CANCELLED':
      return 'Подготовка источника была отменена. Выберите его повторно.'
    default:
      return 'Не удалось запустить захват выбранного источника. Повторите выбор.'
  }
}

/** Main's own wording for a closed or minimised game window (`SETUP_SOURCE_LOST`). */
export const SOURCE_LOST_TEXT = 'Окно игры закрыто или свёрнуто'

/**
 * The one phrase shown for a failed automatic setup (owner rule §1.3). Every internal
 * `AUTO_*` code collapses into one of four texts; codes themselves never reach the UI.
 */
export function autoFailureText(code: string | null): string {
  switch (code) {
    case 'AUTO_VS_TIMEOUT':
      return 'Экран боя не появился за минуту'
    case 'AUTO_SOURCE_LOST':
      return SOURCE_LOST_TEXT
    case 'AUTO_SPECTATE_LIKE':
      return 'Похоже, это не ваш бой. Зайдите к Тренеру Чеддеру'
    default:
      return 'Не получилось настроить автоматически'
  }
}

/** The window is gone: retrying cannot work, a new source has to be chosen. */
export function isSourceLostCode(code: string | null | undefined): boolean {
  return code === 'AUTO_SOURCE_LOST' || code === 'SETUP_SOURCE_LOST'
}

/** Message fragments of `ApplicationError`s that survive IPC, in matching order. */
const COMMAND_FRAGMENTS: readonly (readonly [fragment: string, text: string])[] = [
  ['already active', 'Уже открыта другая настройка. Завершите или отмените её.'],
  ['Setup session is stale', 'Эта настройка уже закрыта или заменена другой.'],
  ['Setup session changed', 'Эта настройка уже закрыта или заменена другой.'],
  ['Setup command is stale', 'Состояние настройки изменилось. Мы его обновили.'],
  ['inside the game rectangle', 'Отметьте область внутри игры'],
  [SOURCE_LOST_TEXT, SOURCE_LOST_TEXT],
  ['откройте её ещё раз', 'Состояние настройки изменилось. Мы его обновили.'],
  [
    'Capture profiles changed',
    'Список профилей изменился, пока шла настройка. Начните заново.',
  ],
  ['signed-in session changed', 'Аккаунт изменился во время настройки. Начните заново.'],
  ['Sign in', 'Войдите в аккаунт заново и повторите настройку.'],
  [
    'different aspect ratio',
    'У нового источника другие пропорции. Перенастройте области профиля.',
  ],
  ['Stop Twitch predictions', 'Остановите прогнозы Twitch, чтобы менять профили.'],
  ['name already exists', 'Профиль с таким названием уже есть. Выберите другое.'],
  ['limit has been reached', 'Достигнут предел — 20 профилей.'],
  ['atomic save', 'Сохранение ещё идёт. Подождите несколько секунд.'],
]

export function commandErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : ''
  return (
    COMMAND_FRAGMENTS.find(([fragment]) => message.includes(fragment))?.[1] ?? fallback
  )
}

/** The failure means the renderer's view of the session is outdated. */
export function isStaleCause(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : ''
  return (
    message.includes('Setup session is stale') ||
    message.includes('Setup command is stale') ||
    message.includes('Setup session changed') ||
    message.includes('откройте её ещё раз')
  )
}

/** Text for the public `error` main attaches to a session view; `null` for unknown codes. */
export function viewErrorMessage(error: {
  code: string
  message: string
}): string | null {
  switch (error.code) {
    case 'SETUP_GAME_NOT_FOUND':
      return 'Не вижу игру в окне — сделайте кадр ещё раз'
    case 'SETUP_SOURCE_LOST':
      return SOURCE_LOST_TEXT
    case 'CAPTURE_PROFILE_STALE':
      return 'Список профилей изменился, пока шла настройка. Отмените её и начните заново.'
    case 'CAPTURE_PROFILE_NAME_CONFLICT':
      return 'Профиль с таким названием уже появился. Отмените настройку и выберите другое название.'
    case 'CAPTURE_PROFILE_LIMIT':
      return 'Достигнут предел — 20 профилей. Удалите ненужный профиль и повторите.'
    case 'AUTH_REQUIRED':
    case 'AUTH_CONTEXT_CHANGED':
      return 'Аккаунт изменился во время настройки. Начните заново.'
    case 'CAPTURE_GEOMETRY_CHANGED':
      return 'Размер окна игры изменился. Начните настройку заново.'
    case 'CAPTURE_NO_FRAME':
    case 'CAPTURE_FREEZE_TIMEOUT':
      return 'Не удалось получить кадр. Проверьте, что игра открыта и окно не свёрнуто.'
    case 'SETUP_REGION_MISSING':
      return 'Сначала отметьте область триггера.'
    case 'SETUP_INCOMPLETE':
      return 'Отметьте все области и проверьте триггер.'
    default:
      return null
  }
}

/** Retrying the save cannot fix these: the session has to be started again. */
export function saveRetryable(code: string | undefined): boolean {
  return !(
    code === 'CAPTURE_PROFILE_STALE' ||
    code === 'CAPTURE_PROFILE_NAME_CONFLICT' ||
    code === 'CAPTURE_PROFILE_LIMIT' ||
    code === 'AUTH_REQUIRED' ||
    code === 'AUTH_CONTEXT_CHANGED'
  )
}
