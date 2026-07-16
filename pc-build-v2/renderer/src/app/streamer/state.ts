import { useEffect, useRef, useState } from 'react'

export function predictionStateLabel(state: string): string {
  const normalized = state.toLocaleLowerCase('en-US')
  if (normalized === 'idle' || normalized === 'stopped') return 'Ожидание запуска'
  if (normalized === 'active' || normalized === 'running') return 'Прогноз выполняется'
  if (normalized === 'failed' || normalized === 'error') return 'Требуется внимание'
  if (normalized === 'resolving') return 'Подводим итог'
  if (normalized === 'creating') return 'Создаём прогноз'
  return 'Состояние обновляется'
}

export function refreshSectionLabel(section: string): string {
  const labels: Record<string, string> = {
    twitch: 'Twitch',
    predictions: 'прогнозы',
    title: 'название стрима',
    deckSharing: 'публикация колод',
    overlay: 'OBS',
  }
  return labels[section] ?? 'часть данных'
}

export function useDraft<T>(serverValue: T): {
  draft: T
  setDraft: (value: T) => void
  dirty: boolean
} {
  const serializedServerValue = JSON.stringify(serverValue)
  const previousServerValue = useRef(serializedServerValue)
  const [draft, setDraft] = useState(serverValue)

  useEffect(() => {
    setDraft((current) =>
      JSON.stringify(current) === previousServerValue.current ? serverValue : current,
    )
    previousServerValue.current = serializedServerValue
  }, [serializedServerValue, serverValue])

  return {
    draft,
    setDraft,
    dirty: JSON.stringify(draft) !== serializedServerValue,
  }
}
