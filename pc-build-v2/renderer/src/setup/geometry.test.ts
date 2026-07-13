import { describe, expect, it } from 'vitest'

import { containTransform, pointerToNormalized, rectFromPoints } from './geometry'

describe('setup contain geometry', () => {
  it('maps pointer coordinates through horizontal letterboxing', () => {
    const transform = containTransform(
      { width: 1000, height: 800 },
      { width: 1920, height: 1080 },
    )
    expect(transform.x).toBeCloseTo(0)
    expect(transform.width).toBeCloseTo(1000)
    expect(transform.height).toBeCloseTo(562.5)
    expect(transform.y).toBeCloseTo(118.75)
    expect(pointerToNormalized(500, 400, 0, 0, transform)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('clamps outside letterbox points and normalizes reverse drags', () => {
    const transform = containTransform(
      { width: 800, height: 800 },
      { width: 800, height: 400 },
    )
    expect(pointerToNormalized(400, 0, 0, 0, transform)).toEqual({ x: 0.5, y: 0 })
    expect(rectFromPoints({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 })).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.6000000000000001,
      height: 0.6,
    })
  })
})
