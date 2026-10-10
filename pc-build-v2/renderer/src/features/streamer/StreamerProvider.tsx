import type { ReactNode } from 'react'

import { StreamerContext } from './streamerContext'
import { useStreamerController } from './useStreamerController'

/**
 * Owns the streamer data while the stream area (or settings, for the accounts count) is
 * open. `enabled` is false for non-streamers: nothing is loaded or polled.
 */
export function StreamerProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: ReactNode
}): React.JSX.Element {
  const controller = useStreamerController(enabled)
  return <StreamerContext value={controller}>{children}</StreamerContext>
}
