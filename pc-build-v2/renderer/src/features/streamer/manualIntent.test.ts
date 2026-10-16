import { describe, expect, it } from 'vitest'

import { confirmManualIntent, manualRequestId } from './manualIntent'

describe('manual prediction intent identity', () => {
  it('keeps each uncertain outcome when another outcome is pressed at the same progress', () => {
    const progress = `user:${crypto.randomUUID()}:41:0`
    const win = manualRequestId(progress, 'win')
    const loss = manualRequestId(progress, 'loss')
    expect(loss).not.toBe(win)
    expect(manualRequestId(progress, 'win')).toBe(win)
    expect(manualRequestId(progress, 'loss')).toBe(loss)
  })

  it('ends only the confirmed skip while retaining other uncertain intents', () => {
    const progress = `user:${crypto.randomUUID()}:41:0`
    const win = manualRequestId(progress, 'win')
    const skip = manualRequestId(progress, 'not_ranked')
    confirmManualIntent(progress, 'not_ranked')
    expect(manualRequestId(progress, 'not_ranked')).not.toBe(skip)
    expect(manualRequestId(progress, 'win')).toBe(win)
  })

  it('changes identity for a different authoritative progress or account', () => {
    const user = crypto.randomUUID()
    const win = manualRequestId(`${user}:41:0`, 'win')
    expect(manualRequestId(`${user}:41:1`, 'win')).not.toBe(win)
    expect(manualRequestId(`other-${user}:41:1`, 'win')).not.toBe(win)
  })
})
