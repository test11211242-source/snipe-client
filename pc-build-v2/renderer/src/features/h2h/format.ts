import type { H2HData } from './useH2H'

export type MeetingResult = H2HData['recent'][number]['result']

const MONTHS = [
  'янв.',
  'февр.',
  'мар.',
  'апр.',
  'мая',
  'июн.',
  'июл.',
  'авг.',
  'сент.',
  'окт.',
  'нояб.',
  'дек.',
] as const

export const RESULT_LABEL: Record<MeetingResult, string> = {
  win: 'Победа',
  loss: 'Поражение',
  draw: 'Ничья',
}

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/** «сегодня», «вчера» or «5 окт.» in the OS-local calendar. */
export function meetingDay(iso: string, now: number = Date.now()): string {
  const date = new Date(iso)
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000)
  if (days === 0) return 'сегодня'
  if (days === 1) return 'вчера'
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`
}

export function clockTime(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** «вчера, 19:42». */
export function meetingWhen(iso: string, now: number = Date.now()): string {
  return `${meetingDay(iso, now)}, ${clockTime(iso)}`
}

/** «1 встреча», «4 встречи», «5 встреч». */
export function meetingsCount(count: number): string {
  const mod100 = count % 100
  const mod10 = count % 10
  const word =
    mod100 >= 11 && mod100 <= 14
      ? 'встреч'
      : mod10 === 1
        ? 'встреча'
        : mod10 >= 2 && mod10 <= 4
          ? 'встречи'
          : 'встреч'
  return `${count} ${word}`
}

/** Newest first, whatever order the server used. */
export function newestFirst<T extends { at: string }>(meetings: readonly T[]): T[] {
  return [...meetings].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

export function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`
}
