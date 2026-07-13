import type { NormalizedRect, PixelSize } from '../../../shared/models/capture'

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
