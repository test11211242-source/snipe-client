/**
 * Russian text for a failed profile command. Main throws `ApplicationError`s whose English
 * messages survive IPC, so the stable fragments below identify the cause. Raw messages
 * never reach the UI.
 */
const KNOWN: readonly (readonly [fragment: string, text: string])[] = [
  ['name already exists', 'Профиль с таким названием уже есть. Выберите другое.'],
  ['limit has been reached', 'Достигнут предел — 20 профилей. Удалите ненужный профиль.'],
  [
    'Capture profiles changed',
    'Список профилей изменился. Мы его обновили — повторите действие.',
  ],
  ['last capture profile', 'Единственный профиль удалить нельзя.'],
  ['no longer exists', 'Такого профиля уже нет. Список обновлён.'],
  ['Stop Twitch predictions', 'Остановите прогнозы Twitch, чтобы менять профили.'],
  [
    'different aspect ratio',
    'У нового источника другие пропорции. Перенастройте области профиля.',
  ],
  [
    'source is unavailable',
    'Источник профиля недоступен. Проверьте, что игра запущена и окно не свёрнуто.',
  ],
  ['Sign in', 'Войдите в аккаунт заново и повторите действие.'],
  ['signed-in session changed', 'Аккаунт изменился. Повторите действие.'],
]

export function profileErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : ''
  return KNOWN.find(([fragment]) => message.includes(fragment))?.[1] ?? fallback
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
