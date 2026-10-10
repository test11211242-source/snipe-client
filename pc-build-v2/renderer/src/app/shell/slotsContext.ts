import { createContext, useContext } from 'react'

export interface ShellSlots {
  /** DOM node inside the mini strip where a page may portal extra controls (История). */
  miniStripExtra: HTMLElement | null
  setMiniStripExtra: (element: HTMLElement | null) => void
}

export const SlotsContext = createContext<ShellSlots | null>(null)

export function useShellSlots(): ShellSlots {
  const slots = useContext(SlotsContext)
  if (slots === null)
    throw new Error('useShellSlots must be used inside ShellSlotsProvider')
  return slots
}

/** Target element of the mini strip extra slot; `createPortal(button, element)` into it. */
export function useMiniStripExtra(): HTMLElement | null {
  return useShellSlots().miniStripExtra
}

/** Shell-owned overlays that pages may open (profiles panel, tag palette). */
export interface ShellActions {
  openProfiles: () => void
  openPalette: () => void
}

const NO_ACTIONS: ShellActions = {
  openProfiles: () => undefined,
  openPalette: () => undefined,
}

export const ShellActionsContext = createContext<ShellActions>(NO_ACTIONS)

export function useShellActions(): ShellActions {
  return useContext(ShellActionsContext)
}
