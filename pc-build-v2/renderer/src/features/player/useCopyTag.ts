import { useCallback } from 'react'

import { useToast } from '../../ui'

/** Copies a canonical player tag through the narrow clipboard bridge, then confirms. */
export function useCopyTag(): (tag: string) => Promise<boolean> {
  const { show } = useToast()
  return useCallback(
    async (tag: string): Promise<boolean> => {
      try {
        await window.crTools.copyPlayerTag(tag)
        show({ message: 'Тег скопирован' })
        return true
      } catch {
        return false
      }
    },
    [show],
  )
}
