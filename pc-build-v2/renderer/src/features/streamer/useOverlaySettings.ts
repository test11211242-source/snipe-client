import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  GameAccountTagSchema,
  type OverlaySettings,
} from '../../../../shared/models/streamer'
import { useStreamer } from './streamerContext'
import { describeCommandError } from './text'

/** Why these settings cannot be sent yet (mirrors the contract's cross-field rules). */
export function overlayProblem(settings: OverlaySettings): string | null {
  if (
    settings.streamerAccountMode === 'manual' &&
    !GameAccountTagSchema.safeParse(settings.manualStreamerTag).success
  )
    return 'Выберите аккаунт, статистика которого пойдёт в виджет.'
  if (
    settings.opponentSecondSlideEnabled &&
    settings.opponentSlideSeconds >= settings.opponentDisplaySeconds
  )
    return 'Второй слайд должен быть короче общего времени показа.'
  return null
}

export interface OverlayController {
  /** Saved settings with the local edits not yet confirmed by the server on top. */
  settings: OverlaySettings
  /** Local edits exist that the server has not confirmed. */
  dirty: boolean
  error: string | null
  /** Applies an edit immediately; the draft stays in the form if saving fails. */
  update: (change: Partial<OverlaySettings>) => void
  retry: () => void
}

/**
 * Widget settings are saved as soon as they change. Edits made while a save is running are
 * merged into the next full settings object, so quick toggles never overwrite each other,
 * and a failed save leaves the edits visible with a retry.
 */
export function useOverlaySettings(): OverlayController {
  const { view, command } = useStreamer()
  const saved = view?.overlay.settings
  const [patch, setPatch] = useState<Partial<OverlaySettings>>({})
  const [error, setError] = useState<string | null>(null)
  const latest = useRef<Partial<OverlaySettings>>({})
  const savedRef = useRef(saved)
  useEffect(() => {
    savedRef.current = saved
  })

  const send = useCallback(
    (sent: Partial<OverlaySettings>): void => {
      const base = savedRef.current
      if (base === undefined) return
      const full: OverlaySettings = { ...base, ...sent }
      const problem = overlayProblem(full)
      setError(problem)
      if (problem !== null) return
      void command(
        { action: 'widget.settings', settings: full },
        { key: 'widget.settings' },
      ).then((outcome) => {
        if (outcome.status === 'ok') {
          // A newer edit keeps its own draft; otherwise the server value is the truth.
          if (latest.current === sent) {
            latest.current = {}
            setPatch({})
          }
          setError(null)
        } else if (outcome.status === 'failed') {
          setError(describeCommandError(outcome.code))
        }
      })
    },
    [command],
  )

  const update = useCallback(
    (change: Partial<OverlaySettings>): void => {
      latest.current = { ...latest.current, ...change }
      setPatch(latest.current)
      send(latest.current)
    },
    [send],
  )

  const settings = useMemo(
    () => (saved === undefined ? undefined : { ...saved, ...patch }),
    [saved, patch],
  )
  return {
    settings: settings as OverlaySettings,
    dirty: Object.keys(patch).length > 0,
    error,
    update,
    retry: () => send(latest.current),
  }
}
