import { describe, expect, it } from 'vitest'

import {
  MIN_REGION_SIDE,
  containTransform,
  hitRect,
  moveRect,
  nudgeRect,
  pointerToNormalized,
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

  it('clamps drawing to the game viewport, including reverse and outside drags', () => {
    const game = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
    expect(rectFromPoints({ x: 0, y: 0 }, { x: 1, y: 1 }, game)).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.6000000000000001,
      height: 0.6000000000000001,
    })
    expect(rectFromPoints({ x: 1, y: 1 }, { x: 0, y: 0 }, game)).toEqual(
      rectFromPoints({ x: 0, y: 0 }, { x: 1, y: 1 }, game),
    )
    expect(rectFromPoints({ x: 0, y: 0 }, { x: 0.1, y: 0.1 }, game)).toBeNull()
  })

  it('keeps moves and every resize corner inside the game viewport', () => {
    const game = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 }
    const inside = { x: 0.3, y: 0.4, width: 0.2, height: 0.1 }
    expect(moveRect(inside, -5, -5, game)).toEqual({ ...inside, x: 0.1, y: 0.2 })
    const moved = moveRect(inside, 5, 5, game)
    expect(moved.x + moved.width).toBeCloseTo(0.8)
    expect(moved.y + moved.height).toBeCloseTo(0.8)
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      for (const point of [
        { x: -1, y: -1 },
        { x: 2, y: 2 },
      ]) {
        const resized = resizeCorner(inside, corner, point, game)
        expect(resized.x).toBeGreaterThanOrEqual(game.x)
        expect(resized.y).toBeGreaterThanOrEqual(game.y)
        expect(resized.x + resized.width).toBeLessThanOrEqual(game.x + game.width)
        expect(resized.y + resized.height).toBeLessThanOrEqual(game.y + game.height)
      }
    }
  })

  it('keeps keyboard moves and keyboard resizing inside the game viewport', () => {
    const game = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
    const inside = { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }
    expect(nudgeRect(inside, 'ArrowLeft', 1, false, game).x).toBe(0.2)
    expect(nudgeRect(inside, 'ArrowUp', 1, false, game).y).toBe(0.2)
    expect(nudgeRect(inside, 'ArrowRight', 1, true, game).width).toBe(0.5)
    expect(nudgeRect(inside, 'ArrowDown', 1, true, game).height).toBe(0.5)
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
