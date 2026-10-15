import type { CaptureProfileErrorCode } from '../../../../shared/contracts/capture-ipc'

const MESSAGES: Partial<Record<CaptureProfileErrorCode, string>> = {
  CAPTURE_PROFILE_NAME_CONFLICT: 'Профиль с таким названием уже есть. Выберите другое.',
  CAPTURE_PROFILE_LIMIT: 'Достигнут предел — 20 профилей. Удалите ненужный профиль.',
  CAPTURE_PROFILE_STALE:
    'Список профилей изменился. Мы его обновили — повторите действие.',
  CAPTURE_PROFILE_LAST: 'Единственный профиль удалить нельзя.',
  CAPTURE_PROFILE_NOT_FOUND: 'Такого профиля уже нет. Список обновлён.',
  CAPTURE_PROFILE_GEOMETRY_MISMATCH:
    'У нового источника другие пропорции. Перенастройте области профиля.',
  CAPTURE_PROFILE_SOURCE_UNAVAILABLE:
    'Источник профиля недоступен. Проверьте, что игра запущена и окно не свёрнуто.',
  SOURCE_NOT_FOUND: 'Источник профиля недоступен. Проверьте, что игра запущена.',
  SOURCE_AMBIGUOUS: 'Найдено несколько подходящих источников. Выберите окно игры заново.',
  SOURCE_REBIND_REQUIRED: 'Выберите окно игры заново в профиле.',
  AUTH_REQUIRED: 'Войдите в аккаунт заново и повторите действие.',
  AUTH_CONTEXT_CHANGED: 'Аккаунт изменился. Повторите действие.',
  CAPTURE_PREPARATION_STALE: 'Выберите источник повторно.',
  CAPTURE_PREPARATION_FAILED: 'Не удалось подготовить источник. Выберите его повторно.',
}

export function profileErrorMessage(
  code: CaptureProfileErrorCode,
  fallback: string,
): string {
  return MESSAGES[code] ?? fallback
}

export const PROFILE_NAME_MAX = 80

/** Client-side check that mirrors main's rules; main stays the authority. */
export function profileNameError(
  name: string,
  others: readonly { profileId: string; profileName: string }[],
  exceptId: string | null,
): string | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'Введите название профиля.'
  if (trimmed.length > PROFILE_NAME_MAX)
    return `Название длиннее ${PROFILE_NAME_MAX} символов — сократите его.`
  const key = trimmed.toLocaleLowerCase('ru-RU')
  if (
    others.some(
      (profile) =>
        profile.profileId !== exceptId &&
        profile.profileName.toLocaleLowerCase('ru-RU') === key,
    )
  )
    return 'Профиль с таким названием уже есть. Выберите другое.'
  return null
}

/** Name for a copy: «Основной — копия», «Основной — копия 2», … unique among profiles. */
export function copyName(base: string, all: readonly { profileName: string }[]): string {
  const taken = new Set(
    all.map((profile) => profile.profileName.toLocaleLowerCase('ru-RU')),
  )
  let candidate = `${base} — копия`
  for (let index = 2; taken.has(candidate.toLocaleLowerCase('ru-RU')); index += 1)
    candidate = `${base} — копия ${index}`
  return candidate.slice(0, PROFILE_NAME_MAX)
}
