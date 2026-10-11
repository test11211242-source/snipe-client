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

export function rectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
): NormalizedRect | null {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  return width >= 0.001 && height >= 0.001 ? { x, y, width, height } : null
}

export function projectInnerRect(
  outer: NormalizedRect,
  inner: NormalizedRect,
): NormalizedRect {
  const precise = (value: number): number => Number(value.toFixed(8))
  return {
    x: precise(outer.x + inner.x * outer.width),
    y: precise(outer.y + inner.y * outer.height),
    width: precise(inner.width * outer.width),
    height: precise(inner.height * outer.height),
  }
}

/** Smallest region side the editor allows (fraction of the frame). */
export const MIN_REGION_SIDE = 0.01

export type RectCorner = 'nw' | 'ne' | 'sw' | 'se'
export type RectHit = { kind: 'handle'; corner: RectCorner } | { kind: 'body' }

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Moves a rect by a normalized delta and keeps it inside the frame. */
export function moveRect(rect: NormalizedRect, dx: number, dy: number): NormalizedRect {
  return {
    ...rect,
    x: clamp(rect.x + dx, 0, 1 - rect.width),
    y: clamp(rect.y + dy, 0, 1 - rect.height),
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
): NormalizedRect {
  const anchorX = corner === 'nw' || corner === 'sw' ? rect.x + rect.width : rect.x
  const anchorY = corner === 'nw' || corner === 'ne' ? rect.y + rect.height : rect.y
  const axis = (anchor: number, value: number): { start: number; size: number } => {
    const forward = value >= anchor
    const size = clamp(
      Math.abs(value - anchor),
      MIN_REGION_SIDE,
      forward ? 1 - anchor : anchor,
    )
    return { start: forward ? anchor : anchor - size, size }
  }
  const horizontal = axis(anchorX, point.x)
  const vertical = axis(anchorY, point.y)
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
): NormalizedRect {
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
  if (!resize) return moveRect(rect, dx, dy)
  return {
    ...rect,
    width: clamp(rect.width + dx, MIN_REGION_SIDE, 1 - rect.x),
    height: clamp(rect.height + dy, MIN_REGION_SIDE, 1 - rect.y),
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
