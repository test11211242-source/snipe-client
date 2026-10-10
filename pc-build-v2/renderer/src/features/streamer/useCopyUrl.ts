import { useCallback, useEffect, useRef, useState } from 'react'

import type { OverlayUrlKind } from '../../../../shared/models/streamer'
import { useToast } from '../../ui'
import { useStreamer } from './streamerContext'
import { describeCommandError } from './text'

export interface CopyUrl {
  /** The kind whose check mark is showing (1.5 s). */
  copied: OverlayUrlKind | null
  error: string | null
  copy: (kind: OverlayUrlKind) => Promise<void>
}

/**
 * Copies a widget URL. The URL itself stays in the main process: the renderer only asks
 * for the copy and learns whether it worked.
 */
export function useCopyUrl(): CopyUrl {
  const { command } = useStreamer()
  const toast = useToast()
  const [copied, setCopied] = useState<OverlayUrlKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(
    async (kind: OverlayUrlKind): Promise<void> => {
      setError(null)
      const outcome = await command(
        { action: 'widget.copy', kind },
        { key: `copy.${kind}` },
      )
      if (outcome.status === 'failed') {
        setError(describeCommandError(outcome.code))
        return
      }
      if (outcome.status !== 'ok') return
      setCopied(kind)
      toast.show({ message: 'Ссылка скопирована' })
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(null), 1_500)
    },
    [command, toast],
  )
  return { copied, error, copy }
}
