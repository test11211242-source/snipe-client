export interface PlacementBox {
  top: number
  left: number
  right: number
  bottom: number
}

export interface MenuPlacement {
  top: number
  left: number
  /** Height cap when neither side fits the whole menu; the menu then scrolls. */
  maxHeight: number
  side: 'down' | 'up'
}

/**
 * Viewport collision handling for a menu opened next to `anchor`: prefer `direction`,
 * flip to the other side when the menu does not fit but the other side has more room,
 * cap the height when neither fits, and shift horizontally to stay inside the viewport.
 */
export function placeMenu(input: {
  anchor: PlacementBox
  menu: { width: number; height: number }
  viewport: { width: number; height: number }
  direction: 'down' | 'up'
  align: 'start' | 'end'
  gap: number
  margin: number
}): MenuPlacement {
  const { anchor, menu, viewport, direction, align, gap, margin } = input
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin)
  const above = Math.max(0, anchor.top - gap - margin)
  const room = { down: below, up: above }
  const other = direction === 'down' ? 'up' : 'down'
  const side =
    menu.height > room[direction] && room[other] > room[direction] ? other : direction
  const height = Math.min(menu.height, room[side])
  const top = side === 'down' ? anchor.bottom + gap : anchor.top - gap - height

  const preferredLeft = align === 'end' ? anchor.right - menu.width : anchor.left
  const maxLeft = viewport.width - menu.width - margin
  const left = Math.max(margin, Math.min(preferredLeft, maxLeft))
  return { top, left, maxHeight: Math.max(height, 0), side }
}
