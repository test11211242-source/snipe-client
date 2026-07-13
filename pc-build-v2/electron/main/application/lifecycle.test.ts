import { describe, expect, it } from 'vitest'

import { ApplicationLifecycle } from './lifecycle'

describe('ApplicationLifecycle', () => {
  it('allows the M1 startup and shutdown path', () => {
    const lifecycle = new ApplicationLifecycle()
    lifecycle.transitionTo('AUTHENTICATING')
    lifecycle.transitionTo('READY')
    lifecycle.transitionTo('SHUTTING_DOWN')
    lifecycle.transitionTo('STOPPED')

    expect(lifecycle.state).toBe('STOPPED')
  })

  it('supports recovery only from active lifecycle states', () => {
    const lifecycle = new ApplicationLifecycle()
    expect(lifecycle.canTransitionTo('RECOVERING')).toBe(false)

    lifecycle.transitionTo('AUTHENTICATING')
    lifecycle.transitionTo('RECOVERING')
    lifecycle.transitionTo('READY')

    expect(lifecycle.state).toBe('READY')
  })

  it('rejects skipped and terminal transitions', () => {
    const lifecycle = new ApplicationLifecycle()
    expect(() => lifecycle.transitionTo('READY')).toThrow(
      'Invalid application lifecycle transition: BOOTING -> READY',
    )
  })
})
