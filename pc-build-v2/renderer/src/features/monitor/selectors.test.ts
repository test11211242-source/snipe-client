import { describe, expect, it } from 'vitest'

import { monitorViewFixture } from '../../../../tests/monitor-fixtures'
import { formatElapsed, selectRunPhase, selectStatus } from './selectors'

describe('monitor selectors', () => {
  it('treats WAITING_SOURCE as running (Stop stays), never as failure', () => {
    const view = monitorViewFixture({ state: 'WAITING_SOURCE', runIntent: true })
    expect(selectRunPhase(view, true)).toBe('waiting-source')
    const status = selectStatus(view, true, null)
    expect(status.text).toBe('Ждём окно игры…')
    expect(status.tone).toBe('warn')
  })

  it('says only that the game window is closed or minimised while the source is minimised', () => {
    const view = monitorViewFixture({
      state: 'READY',
      runIntent: true,
      sourceMinimized: true,
    })
    expect(selectRunPhase(view, true)).toBe('running')
    expect(selectStatus(view, true, null)).toMatchObject({
      text: 'Окно игры закрыто или свёрнуто',
      tone: 'warn',
      live: false,
    })
    const restored = monitorViewFixture({ state: 'READY', runIntent: true })
    expect(selectStatus(restored, true, null).text).toBe('Ждём бой')
  })

  it('maps start, failure, first run and stop', () => {
    expect(selectRunPhase(monitorViewFixture({ state: 'STARTING' }), true)).toBe(
      'starting',
    )
    expect(selectRunPhase(monitorViewFixture({ state: 'FAILED' }), true)).toBe('failed')
    expect(
      selectRunPhase(monitorViewFixture({ state: 'FAILED', runIntent: true }), true),
    ).toBe('waiting-source')
    expect(selectRunPhase(monitorViewFixture(), false)).toBe('no-profile')
    expect(selectStatus(monitorViewFixture(), true, null).text).toBe('Остановлено')
  })

  it('shows reconnect state while running without hiding the monitor', () => {
    const view = monitorViewFixture({ state: 'READY', runIntent: true })
    const status = selectStatus(view, true, {
      state: 'BACKOFF',
      desiredConnected: true,
      reconnectAttempt: 2,
      unknownEventCount: 0,
    })
    expect(status.text).toBe('Нет связи с сервером')
  })

  it('formats elapsed time', () => {
    expect(formatElapsed(751_000)).toBe('12:31')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
  })
})
