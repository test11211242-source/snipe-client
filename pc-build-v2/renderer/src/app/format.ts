import type { AuthState, UserRole } from '../../../shared/models/auth'
import type { RealtimeStatus } from '../../../shared/models/network'
import type { UpdateState } from '../../../shared/models/update'

export function realtimeLabel(realtime: RealtimeStatus | null): string {
  if (realtime === null) return 'Проверяем соединение'
  if (realtime.state === 'READY') return 'Связь установлена'
  if (realtime.state === 'DISCONNECTED') return 'Нет соединения'
  if (realtime.state === 'BACKOFF') return 'Повторное подключение'
  return 'Устанавливаем соединение'
}

export function authLabel(
  role: UserRole | undefined,
  state: AuthState | undefined,
): string {
  if (role === 'admin') return 'Администратор'
  if (role === 'streamer') return 'Стример'
  if (role === 'premium') return 'Премиум'
  if (role === 'user') return 'Пользователь'
  if (state === 'BLOCKED') return 'Доступ ограничен'
  if (state === 'ERROR') return 'Ошибка профиля'
  if (state === 'UNAUTHENTICATED') return 'Вход не выполнен'
  return 'Проверяем профиль'
}

export function updateStateLabel(state: UpdateState | null): string {
  if (state === null) return 'Проверяем обновления'
  const labels: Record<UpdateState, string> = {
    IDLE: 'Готово к проверке',
    CHECKING: 'Проверяем',
    AVAILABLE: 'Доступно обновление',
    DOWNLOADING: 'Загружаем',
    READY: 'Готово к установке',
    UP_TO_DATE: 'Установлена актуальная версия',
    FAILED: 'Проверка не удалась',
  }
  return labels[state]
}

export function formatDeckCount(count: number): string {
  const remainder100 = count % 100
  const remainder10 = count % 10
  const noun =
    remainder10 === 1 && remainder100 !== 11
      ? 'колода'
      : remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14)
        ? 'колоды'
        : 'колод'
  return `${count} ${noun}`
}

export function publicErrorMessage(code: string, fallback: string): string {
  const messages: Readonly<Record<string, string>> = {
    AUTH_REQUIRED: 'Требуется повторный вход в профиль.',
    SOURCE_NOT_FOUND: 'Сохранённый источник захвата не найден.',
    SOURCE_AMBIGUOUS:
      'Найдено несколько подходящих источников. Выберите источник заново.',
    CAPTURE_SOURCE_CLOSED: 'Источник захвата был закрыт.',
    CAPTURE_START_FAILED: 'Не удалось запустить захват выбранного источника.',
    MONITOR_START_FAILED: 'Не удалось запустить локальный мониторинг.',
    MONITOR_READY_TIMEOUT: 'Источник захвата не ответил вовремя.',
    MONITOR_PROCESS_EXITED: 'Локальный процесс мониторинга неожиданно завершился.',
    REQUEST_TIMEOUT: 'Сервис не ответил вовремя. Повторите операцию.',
    SERVER_ERROR: 'Сервис временно недоступен.',
    UPDATE_CHECK_FAILED: 'Не удалось проверить наличие обновления.',
    UPDATE_DOWNLOAD_FAILED: 'Не удалось загрузить обновление.',
    UPDATE_INSTALL_FAILED: 'Не удалось запустить установку обновления.',
  }
  const known = messages[code]
  if (known !== undefined) return known
  return /[А-Яа-яЁё]/.test(fallback)
    ? fallback
    : 'Операция не выполнена. Повторите попытку или откройте технические подробности.'
}
