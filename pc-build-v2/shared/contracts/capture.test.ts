import { describe, expect, it } from 'vitest'

import { NormalizedRectSchema } from '../models/capture'
import { SetRegionPayloadSchema } from './capture-ipc'

describe('capture contracts', () => {
  it('accepts bounded normalized rectangles and rejects overflow', () => {
    expect(
      NormalizedRectSchema.parse({ x: 0.2, y: 0.1, width: 0.8, height: 0.9 }),
    ).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.8,
      height: 0.9,
    })
    for (const rect of [
      { x: -0.1, y: 0, width: 0.5, height: 0.5 },
      { x: 0.8, y: 0, width: 0.3, height: 0.5 },
      { x: 0, y: 0.9, width: 0.5, height: 0.2 },
      { x: 0, y: 0, width: 0, height: 1 },
    ]) {
      expect(NormalizedRectSchema.safeParse(rect).success).toBe(false)
    }
  })

  it('rejects renderer fields outside the narrow command DTO', () => {
    expect(() =>
      SetRegionPayloadSchema.parse({
        sessionId: 'd52a21a9-3794-4a51-a292-60ec1ce9c238',
        generation: 1,
        region: 'trigger',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        hwnd: '123',
      }),
    ).toThrow()
  })
})
