import { useState, type ReactNode } from 'react'

import { SlotsContext } from './slotsContext'

export function ShellSlotsProvider({
  children,
}: {
  children: ReactNode
}): React.JSX.Element {
  const [miniStripExtra, setMiniStripExtra] = useState<HTMLElement | null>(null)
  return (
    <SlotsContext.Provider value={{ miniStripExtra, setMiniStripExtra }}>
      {children}
    </SlotsContext.Provider>
  )
}
