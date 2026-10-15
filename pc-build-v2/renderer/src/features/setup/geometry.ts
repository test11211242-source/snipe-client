import type { NormalizedRect, PixelSize } from '../../../../shared/models/capture'

export interface ContainTransform {
  x: number
  y: number
  width: number
  height: number
}

export function containTransform(
  container: PixelSize,
  source: PixelSize,
): ContainTransform {
  const scale = Math.min(container.width / source.width, container.height / source.height)
  const width = source.width * scale
  const height = source.height * scale
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  }
}

export function pointerToNormalized(
  clientX: number,
  clientY: number,
  containerLeft: number,
  containerTop: number,
  transform: ContainTransform,
): { x: number; y: number } {
  return {
    x: Math.min(
      1,
      Math.max(0, (clientX - containerLeft - transform.x) / transform.width),
    ),
    y: Math.min(
      1,
      Math.max(0, (clientY - containerTop - transform.y) / transform.height),
    ),
  }
}

const FRAME_BOUNDS: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 }

export function rectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: NormalizedRect = FRAME_BOUNDS,
): NormalizedRect | null {
  const left = clamp(start.x, bounds.x, bounds.x + bounds.width)
  const top = clamp(start.y, bounds.y, bounds.y + bounds.height)
  const right = clamp(end.x, bounds.x, bounds.x + bounds.width)
  const bottom = clamp(end.y, bounds.y, bounds.y + bounds.height)
  const x = Math.min(left, right)
  const y = Math.min(top, bottom)
  const width = Math.abs(right - left)
  const height = Math.abs(bottom - top)
  return width >= 0.001 && height >= 0.001 ? { x, y, width, height } : null
}

/** Smallest region side the editor allows (fraction of the frame). */
export const MIN_REGION_SIDE = 0.01

export type RectCorner = 'nw' | 'ne' | 'sw' | 'se'
export type RectHit = { kind: 'handle'; corner: RectCorner } | { kind: 'body' }

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Moves a rect by a normalized delta and keeps it inside the editing bounds. */
export function moveRect(
  rect: NormalizedRect,
  dx: number,
  dy: number,
  bounds: NormalizedRect = FRAME_BOUNDS,
): NormalizedRect {
  return {
    ...rect,
    x: clamp(rect.x + dx, bounds.x, bounds.x + bounds.width - rect.width),
    y: clamp(rect.y + dy, bounds.y, bounds.y + bounds.height - rect.height),
  }
}

/**
 * Drags one corner to `point`; the opposite corner stays fixed. Dragging past the fixed
 * corner flips the rect, and no side gets shorter than `MIN_REGION_SIDE`.
 */
export function resizeCorner(
  rect: NormalizedRect,
  corner: RectCorner,
  point: { x: number; y: number },
  bounds: NormalizedRect = FRAME_BOUNDS,
): NormalizedRect {
  const anchorX = corner === 'nw' || corner === 'sw' ? rect.x + rect.width : rect.x
  const anchorY = corner === 'nw' || corner === 'ne' ? rect.y + rect.height : rect.y
  const axis = (
    anchor: number,
    value: number,
    min: number,
    max: number,
  ): { start: number; size: number } => {
    const forward = value >= anchor
    const size = clamp(
      Math.abs(value - anchor),
      MIN_REGION_SIDE,
      forward ? max - anchor : anchor - min,
    )
    return { start: clamp(forward ? anchor : anchor - size, min, max - size), size }
  }
  const horizontal = axis(anchorX, point.x, bounds.x, bounds.x + bounds.width)
  const vertical = axis(anchorY, point.y, bounds.y, bounds.y + bounds.height)
  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.size,
    height: vertical.size,
  }
}

/** Keyboard edit: arrows move, with `resize` they change width/height from the top-left. */
export function nudgeRect(
  rect: NormalizedRect,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  step: number,
  resize: boolean,
  bounds: NormalizedRect = FRAME_BOUNDS,
): NormalizedRect {
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
  if (!resize) return moveRect(rect, dx, dy, bounds)
  return {
    ...rect,
    width: clamp(rect.width + dx, MIN_REGION_SIDE, bounds.x + bounds.width - rect.x),
    height: clamp(rect.height + dy, MIN_REGION_SIDE, bounds.y + bounds.height - rect.y),
  }
}

/** What a pointer press at `point` grabs: a corner handle, the body, or nothing. */
export function hitRect(
  rect: NormalizedRect,
  point: { x: number; y: number },
  tolerance: { x: number; y: number },
): RectHit | null {
  const corners: [RectCorner, number, number][] = [
    ['nw', rect.x, rect.y],
    ['ne', rect.x + rect.width, rect.y],
    ['sw', rect.x, rect.y + rect.height],
    ['se', rect.x + rect.width, rect.y + rect.height],
  ]
  for (const [corner, x, y] of corners) {
    if (Math.abs(point.x - x) <= tolerance.x && Math.abs(point.y - y) <= tolerance.y)
      return { kind: 'handle', corner }
  }
  const inside =
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  return inside ? { kind: 'body' } : null
}

/** Pixel readout of a normalized rect on a frame of `size`. */
export function rectToPixels(
  rect: NormalizedRect,
  size: PixelSize,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(rect.x * size.width),
    y: Math.round(rect.y * size.height),
    width: Math.round(rect.width * size.width),
    height: Math.round(rect.height * size.height),
  }
}

export function sameRect(
  left: NormalizedRect | null,
  right: NormalizedRect | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  )
}
