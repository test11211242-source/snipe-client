import { describe, expect, it } from 'vitest'

import {
  MIN_REGION_SIDE,
  containTransform,
  hitRect,
  moveRect,
  nudgeRect,
  pointerToNormalized,
  projectInnerRect,
  rectFromPoints,
  rectToPixels,
  resizeCorner,
  sameRect,
} from './geometry'

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

describe('setup region editing geometry', () => {
  const rect = { x: 0.2, y: 0.3, width: 0.2, height: 0.1 }

  it('moves a rect and keeps it inside the frame', () => {
    expect(moveRect(rect, 0.1, -0.1)).toEqual({
      x: 0.30000000000000004,
      y: 0.19999999999999998,
      width: 0.2,
      height: 0.1,
    })
    expect(moveRect(rect, 5, 5)).toEqual({ x: 0.8, y: 0.9, width: 0.2, height: 0.1 })
    expect(moveRect(rect, -5, -5)).toEqual({ x: 0, y: 0, width: 0.2, height: 0.1 })
  })

  it('resizes from a corner with the opposite corner fixed and flips past it', () => {
    expect(resizeCorner(rect, 'se', { x: 0.6, y: 0.6 })).toEqual({
      x: 0.2,
      y: 0.3,
      width: 0.39999999999999997,
      height: 0.3,
    })
    const flipped = resizeCorner(rect, 'se', { x: 0.1, y: 0.1 })
    expect(flipped.x).toBeCloseTo(0.1)
    expect(flipped.y).toBeCloseTo(0.1)
    expect(flipped.width).toBeCloseTo(0.1)
    expect(flipped.height).toBeCloseTo(0.2)
    const nw = resizeCorner(rect, 'nw', { x: 0, y: 0 })
    expect(nw).toEqual({ x: 0, y: 0, width: 0.4, height: 0.4 })
  })

  it('never shrinks a side below the minimum and stays inside the frame', () => {
    const tiny = resizeCorner(rect, 'se', { x: 0.2, y: 0.3 })
    expect(tiny.width).toBe(MIN_REGION_SIDE)
    expect(tiny.height).toBe(MIN_REGION_SIDE)
    const clamped = resizeCorner(rect, 'se', { x: 2, y: 2 })
    expect(clamped.x + clamped.width).toBeCloseTo(1)
    expect(clamped.y + clamped.height).toBeCloseTo(1)
  })

  it('nudges by keyboard and resizes with the modifier', () => {
    expect(nudgeRect(rect, 'ArrowRight', 0.05, false).x).toBeCloseTo(0.25)
    expect(nudgeRect(rect, 'ArrowDown', 0.05, true).height).toBeCloseTo(0.15)
    expect(nudgeRect(rect, 'ArrowLeft', 0.5, true).width).toBe(MIN_REGION_SIDE)
  })

  it('hits corner handles before the body and misses outside', () => {
    const tolerance = { x: 0.02, y: 0.02 }
    expect(hitRect(rect, { x: 0.21, y: 0.31 }, tolerance)).toEqual({
      kind: 'handle',
      corner: 'nw',
    })
    expect(hitRect(rect, { x: 0.4, y: 0.4 }, tolerance)).toEqual({
      kind: 'handle',
      corner: 'se',
    })
    expect(hitRect(rect, { x: 0.3, y: 0.35 }, tolerance)).toEqual({ kind: 'body' })
    expect(hitRect(rect, { x: 0.9, y: 0.9 }, tolerance)).toBeNull()
  })

  it('projects the inner structure rect into the outer region', () => {
    expect(
      projectInnerRect(
        { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
        { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
      ),
    ).toEqual({ x: 0.3, y: 0.4, width: 0.2, height: 0.1 })
  })

  it('formats pixel readouts and compares rects', () => {
    expect(
      rectToPixels(
        { x: 0.5, y: 0.25, width: 0.25, height: 0.5 },
        { width: 2560, height: 1440 },
      ),
    ).toEqual({
      x: 1280,
      y: 360,
      width: 640,
      height: 720,
    })
    expect(sameRect(rect, { ...rect })).toBe(true)
    expect(sameRect(rect, null)).toBe(false)
  })
})
