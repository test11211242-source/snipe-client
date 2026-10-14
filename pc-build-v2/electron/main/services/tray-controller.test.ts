import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { DEFAULT_WIDGET_SETTINGS } from '../infrastructure/widget-settings-repository'
import { monitorViewFixture } from '../../../tests/monitor-fixtures'

const native = vi.hoisted(() => ({
  templates: [] as MenuItemConstructorOptions[][],
  instances: [] as {
    on: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    setContextMenu: ReturnType<typeof vi.fn>
  }[],
}))
vi.mock('electron', () => ({
  nativeImage: { createFromDataURL: vi.fn(() => ({})) },
  Menu: {
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => {
      native.templates.push(template)
      return template
    }),
  },
  Tray: class {
    on = vi.fn()
    destroy = vi.fn()
    setToolTip = vi.fn()
    setContextMenu = vi.fn()
    constructor() {
      native.instances.push(this)
    }
  },
}))
import { TrayController } from './tray-controller'

beforeEach(() => {
  native.templates.length = 0
  native.instances.length = 0
})

function harness() {
  let view = monitorViewFixture()
  let listener: (() => void) | undefined
  const dispose = vi.fn()
  const monitor = {
    getCurrentView: () => view,
    subscribeViews: vi.fn((next: () => void) => {
      listener = next
      return dispose
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }
  const profiles = {
    getView: vi.fn().mockResolvedValue({
      revision: 1,
      activeProfileId: 'profile-1',
      profiles: [
        { profileId: 'profile-1', profileName: 'Primary', isActive: true },
        { profileId: 'profile-2', profileName: 'Secondary', isActive: false },
      ],
    }),
    activate: vi.fn().mockResolvedValue(undefined),
  }
  const widget = {
    getStatus: vi.fn(() => ({
      settings: DEFAULT_WIDGET_SETTINGS,
      visible: false,
      lastResult: null,
    })),
    toggle: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
  }
  const open = vi.fn()
  const exit = vi.fn().mockResolvedValue(undefined)
  const controller = new TrayController(
    monitor as never,
    profiles as never,
    widget as never,
    open,
    exit,
    { warn: vi.fn() } as never,
  )
  const menu = () => native.templates.at(-1) ?? []
  const click = (label: string) => {
    const item = menu().find((entry) => entry.label === label)
    if (item?.click === undefined) throw new Error(`Missing tray item ${label}`)
    ;(item.click as () => void)()
  }
  return {
    controller,
    monitor,
    profiles,
    widget,
    open,
    exit,
    menu,
    click,
    dispose,
    push: (next: typeof view) => {
      view = next
      listener?.()
    },
  }
}

describe('native tray lifecycle', () => {
  it('creates one native tray with restore, start and authoritative exit actions', async () => {
    const test = harness()
    test.controller.start()
    test.controller.start()
    expect(native.instances).toHaveLength(1)
    await test.controller.refresh()
    expect(
      test.menu().find((entry) => entry.label === 'Начать мониторинг')?.enabled,
    ).toBe(true)
    test.click('Открыть CR Tools')
    expect(test.open).toHaveBeenCalledOnce()
    const doubleClick = native.instances[0]?.on.mock.calls.find(
      ([event]) => event === 'double-click',
    )?.[1] as (() => void) | undefined
    doubleClick?.()
    expect(test.open).toHaveBeenCalledTimes(2)
    test.click('Начать мониторинг')
    expect(test.monitor.start).toHaveBeenCalledOnce()
    test.click('Выход')
    expect(test.exit).toHaveBeenCalledOnce()
    test.controller.stop()
    expect(test.dispose).toHaveBeenCalledOnce()
    expect(native.instances[0]?.destroy).toHaveBeenCalledOnce()
  })

  it('projects WAITING_SOURCE and operates stop, overlay show and current lock state', () => {
    const test = harness()
    test.controller.start()
    test.push(monitorViewFixture({ state: 'WAITING_SOURCE', runIntent: true }))
    expect(test.menu()[0]?.label).toBe('Ждём окно игры…')
    test.click('Остановить мониторинг')
    test.click('Показать оверлей')
    test.click('Заблокировать оверлей')
    expect(test.monitor.stop).toHaveBeenCalledOnce()
    expect(test.widget.toggle).toHaveBeenCalledOnce()
    expect(test.widget.updateSettings).toHaveBeenCalledWith({ locked: true })
    test.controller.stop()
  })

  it('keeps one label through source retries and shows a worker restart as running', () => {
    const test = harness()
    test.controller.start()
    for (const state of ['WAITING_SOURCE', 'PREFLIGHT', 'STARTING'] as const) {
      test.push(monitorViewFixture({ state, runIntent: true, recovery: 'source' }))
      expect(test.menu()[0]?.label).toBe('Ждём окно игры…')
    }
    test.push(
      monitorViewFixture({
        state: 'WAITING_SOURCE',
        runIntent: true,
        recovery: 'worker',
      }),
    )
    expect(test.menu()[0]?.label).toBe('Мониторинг включён')
    test.controller.stop()
  })

  it('switches profiles using the current main revision rather than stale menu data', async () => {
    const test = harness()
    test.controller.start()
    await test.controller.refresh()
    const submenu = test.menu().find((entry) => entry.label === 'Профиль')?.submenu
    if (!Array.isArray(submenu)) throw new Error('Missing profile submenu')
    expect(submenu[0]?.checked).toBe(true)
    test.profiles.getView.mockResolvedValue({
      revision: 9,
      activeProfileId: 'profile-1',
      profiles: [],
    })
    ;(submenu[1]?.click as () => void)()
    await Promise.resolve()
    expect(test.profiles.activate).toHaveBeenCalledWith('profile-2', 9)
    test.controller.stop()
  })

  it('fences deferred profile refresh after tray destruction', async () => {
    const test = harness()
    test.controller.start()
    const gate = Promise.withResolvers<unknown>()
    test.profiles.getView.mockReturnValueOnce(gate.promise)
    const refreshing = test.controller.refresh()
    const rendered = native.templates.length
    test.controller.stop()
    gate.resolve({ revision: 1, activeProfileId: null, profiles: [] })
    await refreshing
    expect(native.templates).toHaveLength(rendered)
  })
})

describe('review regression tray click exceptions', () => {
  it('#13 catches a synchronous lock-status failure after the menu was rendered', async () => {
    const test = harness()
    test.controller.start()
    test.widget.getStatus.mockImplementation(() => {
      throw new Error('Auth torn down')
    })
    expect(() => test.click('Заблокировать оверлей')).not.toThrow()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(test.widget.updateSettings).not.toHaveBeenCalled()
    test.controller.stop()
  })
})

describe('approved review projection followup', () => {
  it('projects a specific rebind instruction in the native tray', () => {
    const test = harness()
    test.controller.start()
    test.push(
      monitorViewFixture({
        state: 'FAILED',
        error: { code: 'SOURCE_REBIND_REQUIRED', message: 'Generic retry' },
      }),
    )
    expect(test.menu()[0]?.label).toBe('Выберите окно игры заново в профиле')
    test.controller.stop()
  })
})
