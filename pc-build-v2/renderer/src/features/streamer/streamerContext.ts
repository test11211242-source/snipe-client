import { createContext, useContext } from 'react'

import type { StreamerController } from './useStreamerController'

export const StreamerContext = createContext<StreamerController | null>(null)

/** The streamer data of the surrounding `StreamerProvider`. */
export function useStreamer(): StreamerController {
  const controller = useContext(StreamerContext)
  if (controller === null)
    throw new Error('useStreamer must be used inside StreamerProvider')
  return controller
}
