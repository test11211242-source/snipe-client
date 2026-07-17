import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  session: { defaultSession: {} },
}))

import type { AuthView } from '../../../shared/models/auth'
import { ApplicationController } from './application-controller'

function authenticated(userId: string): AuthView {
  return {
    state: 'AUTHENTICATED',
    user: {
      id: userId,
      username: `user-${userId}`,
      email: `${userId}@example.com`,
      role: 'premium',
      roles: ['premium'],
    },
    deviceHint: null,
    error: null,
  }
}

describe('ApplicationController user context', () => {
  it('clears user-visible services across A -> logout -> B', async () => {
    const windows = {
      ensureMainWindow: vi.fn().mockResolvedValue(undefined),
      ensureAuthWindow: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    }
    const realtime = { start: vi.fn(), stop: vi.fn() }
    const setup = {
      getSession: vi.fn(() => {
        throw new Error('no setup')
      }),
      cancel: vi.fn(),
    }
    const monitor = {
      stop: vi.fn().mockResolvedValue({ state: 'STOPPED' }),
      setUserContext: vi.fn(),
    }
    const widget = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const images = { stop: vi.fn() }
    const notifications = { start: vi.fn(), stop: vi.fn() }
    const reprocessedResults = { start: vi.fn(), stop: vi.fn() }
    const streamer = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const capturePreparations = { stop: vi.fn().mockResolvedValue(undefined) }
    const controller = new ApplicationController(
      {} as never,
      windows as never,
      {} as never,
      {} as never,
      {} as never,
      realtime as never,
      {} as never,
      setup as never,
      monitor as never,
      widget as never,
      images as never,
      notifications as never,
      reprocessedResults as never,
      streamer as never,
      {} as never,
      capturePreparations as never,
    )
    const syncWindows = (
      controller as unknown as { syncWindows: (view: AuthView) => Promise<void> }
    ).syncWindows.bind(controller)

    await syncWindows(authenticated('A'))
    await syncWindows({
      state: 'UNAUTHENTICATED',
      user: null,
      deviceHint: null,
      error: null,
    })
    await syncWindows(authenticated('B'))

    expect(monitor.setUserContext).toHaveBeenNthCalledWith(1, 'A')
    expect(monitor.setUserContext).toHaveBeenNthCalledWith(2, null)
    expect(monitor.setUserContext).toHaveBeenNthCalledWith(3, 'B')
    expect(widget.stop).toHaveBeenCalledWith('auth-transition')
    expect(images.stop).toHaveBeenCalledTimes(3)
    expect(reprocessedResults.stop).toHaveBeenCalled()
    expect(notifications.stop).toHaveBeenCalled()
    expect(widget.start).toHaveBeenNthCalledWith(1, 'A')
    expect(widget.start).toHaveBeenNthCalledWith(2, 'B')
    expect(capturePreparations.stop).toHaveBeenCalled()
    expect(reprocessedResults.start).toHaveBeenNthCalledWith(1, 'A')
    expect(reprocessedResults.start).toHaveBeenNthCalledWith(2, 'B')
  })
})
