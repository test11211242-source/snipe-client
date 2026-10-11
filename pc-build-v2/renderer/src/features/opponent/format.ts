/** «2 ч 14 мин», «5 мин», «40 с». */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`
  if (minutes > 0) return `${minutes} мин`
  return `${seconds} с`
}
