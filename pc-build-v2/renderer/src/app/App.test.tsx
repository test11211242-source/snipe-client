// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewPayload } from '../../../shared/contracts/capture-ipc'
import { App } from './App'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('App shell', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'crTools', {
      configurable: true,
      value: Object.freeze({
        hello: vi.fn().mockResolvedValue({
          protocolVersion: 1,
          message: 'hello from CR Tools V2',
        }),
        getAppSnapshot: vi.fn().mockResolvedValue({
          lifecycle: 'READY',
          version: '0.1.0',
          settingsVersion: 1,
        }),
        getAppSettings: vi.fn().mockResolvedValue({
          reducedMotion: false,
          launchAtStartup: false,
          diagnosticsEnabled: false,
        }),
        updateAppSettings: vi
          .fn()
          .mockImplementation((settings) => Promise.resolve(settings)),
        getAuthView: vi.fn().mockResolvedValue({
          state: 'AUTHENTICATED',
          user: {
            id: '42',
            username: 'operator',
            email: 'operator@example.com',
            role: 'premium',
            roles: ['premium'],
          },
          deviceHint: '12345678...abcd',
          error: null,
        }),
        getRealtimeStatus: vi.fn().mockResolvedValue({
          state: 'AUTHENTICATING',
          desiredConnected: true,
          reconnectAttempt: 0,
          unknownEventCount: 0,
        }),
        getCaptureStatus: vi.fn().mockResolvedValue({
          configured: false,
          revision: null,
          sourceLabel: null,
        }),
        getCaptureProfiles: vi.fn().mockResolvedValue({
          revision: null,
          activeProfileId: null,
          profiles: [],
        }),
        activateCaptureProfile: vi.fn(),
        renameCaptureProfile: vi.fn(),
        duplicateCaptureProfile: vi.fn(),
        deleteCaptureProfile: vi.fn(),
        rebindCaptureProfile: vi.fn(),
        listCaptureSources: vi.fn().mockResolvedValue({
          revision: 'a'.repeat(32),
          expiresAt: Date.now() + 30_000,
          sources: [],
        }),
        prepareCaptureSource: vi
          .fn()
          .mockImplementation(({ sourceKey, revision }: PreviewPayload) =>
            Promise.resolve({
              preparationId: '00000000-0000-4000-8000-000000000020',
              sourceKey,
              revision,
            }),
          ),
        releaseCaptureSource: vi.fn().mockResolvedValue({ released: true }),
        startCaptureSetup: vi.fn(),
        getMonitorView: vi.fn().mockResolvedValue({
          state: 'STOPPED',
          preferences: { searchMode: 'fast', deckMode: 'pol' },
          readiness: {
            authenticated: true,
            captureConfigured: false,
            sourceAvailable: null,
          },
          error: null,
          startedAt: null,
          stats: {
            triggers: 0,
            requests: 0,
            droppedActions: 0,
            playersFound: 0,
            playersNotFound: 0,
            recognitionFailures: 0,
            serviceErrors: 0,
          },
          results: [],
        }),
        startMonitor: vi.fn(),
        stopMonitor: vi.fn(),
        getMonitorPreferences: vi
          .fn()
          .mockResolvedValue({ searchMode: 'fast', deckMode: 'pol' }),
        updateMonitorPreferences: vi.fn(),
        getWidgetStatus: vi.fn().mockResolvedValue({
          settings: {
            autoOpen: true,
            alwaysOnTop: true,
            locked: false,
            opacity: 0.96,
            compactMode: false,
            bounds: { x: null, y: null, width: 420, height: 560 },
          },
          visible: false,
          hasResult: false,
        }),
        showWidget: vi.fn(),
        toggleWidget: vi.fn(),
        updateWidgetSettings: vi
          .fn()
          .mockImplementation((settings) => Promise.resolve(settings)),
        getUpdateView: vi.fn().mockResolvedValue({
          state: 'UP_TO_DATE',
          currentVersion: '0.1.0',
          availableVersion: null,
          critical: false,
          releaseNotes: [],
          progress: null,
          error: null,
        }),
        checkForUpdate: vi.fn(),
        downloadUpdate: vi.fn(),
        cancelUpdate: vi.fn(),
        installUpdate: vi.fn(),
        logout: vi.fn().mockResolvedValue({
          state: 'UNAUTHENTICATED',
          user: null,
          deviceHint: null,
          error: null,
        }),
      }),
    })
  })

  it('renders operational monitor readiness and keeps capture navigation functional', async () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: 'Проверяем готовность системы' }),
    ).toBeVisible()
    expect((await screen.findAllByText('operator')).length).toBeGreaterThan(0)
    expect(screen.getByText('Устанавливаем соединение')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Выбрать источник' })).toBeEnabled()
    expect(document.body.textContent).not.toContain('IPC')
    expect(document.body.textContent).not.toContain('LOADING')

    fireEvent.click(screen.getByRole('button', { name: 'Захват' }))
    expect(screen.getByRole('heading', { name: 'Источник захвата' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 1, name: 'Захват' })).toHaveFocus()
  })

  it('shows the honest unsigned-publisher warning in update settings', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    expect(await screen.findByText(/Windows может показать сообщение/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeVisible()
    expect(screen.getByText(/Данные автоматически не отправляются/)).toBeVisible()
  })

  it('switches the active capture profile from the home page', async () => {
    const primary = {
      profileId: '00000000-0000-4000-8000-000000000001',
      profileName: 'Основной',
      isActive: true,
      sourceLabel: 'Emulator 1',
    }
    const secondary = {
      profileId: '00000000-0000-4000-8000-000000000002',
      profileName: 'Второй',
      isActive: false,
      sourceLabel: 'Emulator 2',
    }
    vi.mocked(window.crTools.getCaptureProfiles).mockResolvedValue({
      revision: 1,
      activeProfileId: primary.profileId,
      profiles: [primary, secondary] as never,
    })
    const monitor = await window.crTools.getMonitorView()
    vi.mocked(window.crTools.activateCaptureProfile).mockResolvedValue({
      profiles: {
        revision: 2,
        activeProfileId: secondary.profileId,
        profiles: [
          { ...primary, isActive: false },
          { ...secondary, isActive: true },
        ] as never,
      },
      monitor,
      capture: { configured: true, revision: 1, sourceLabel: 'Emulator 2' },
    })
    render(<App />)

    fireEvent.change(await screen.findByLabelText('Профиль захвата'), {
      target: { value: secondary.profileId },
    })

    await waitFor(() =>
      expect(window.crTools.activateCaptureProfile).toHaveBeenCalledWith({
        profileId: secondary.profileId,
        expectedRevision: 1,
      }),
    )
  })

  it('does not let an older focus refresh overwrite a profile mutation snapshot', async () => {
    const primary = {
      profileId: '00000000-0000-4000-8000-000000000001',
      profileName: 'Основной',
      isActive: true,
      sourceLabel: 'Emulator 1',
    }
    const secondary = {
      profileId: '00000000-0000-4000-8000-000000000002',
      profileName: 'Второй',
      isActive: false,
      sourceLabel: 'Emulator 2',
    }
    const staleProfiles = {
      revision: 1,
      activeProfileId: primary.profileId,
      profiles: [primary, secondary] as never,
    }
    const nextProfiles = {
      revision: 2,
      activeProfileId: secondary.profileId,
      profiles: [
        { ...primary, isActive: false },
        { ...secondary, isActive: true },
      ] as never,
    }
    vi.mocked(window.crTools.getCaptureProfiles).mockResolvedValue(staleProfiles)
    const monitor = await window.crTools.getMonitorView()
    vi.mocked(window.crTools.activateCaptureProfile).mockResolvedValue({
      profiles: nextProfiles,
      monitor,
      capture: { configured: true, revision: 2, sourceLabel: 'Emulator 2' },
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Захват' }))
    await screen.findByText('Второй')

    const statusRefresh = deferred<{
      configured: boolean
      revision: number | null
      sourceLabel: string | null
    }>()
    const profilesRefresh = deferred<typeof staleProfiles>()
    vi.mocked(window.crTools.getCaptureStatus).mockResolvedValue({
      configured: true,
      revision: 2,
      sourceLabel: 'Emulator 2',
    })
    vi.mocked(window.crTools.getCaptureProfiles).mockResolvedValue(nextProfiles)
    vi.mocked(window.crTools.getCaptureStatus).mockReturnValueOnce(statusRefresh.promise)
    vi.mocked(window.crTools.getCaptureProfiles).mockReturnValueOnce(
      profilesRefresh.promise,
    )
    window.dispatchEvent(new Event('focus'))
    fireEvent.click(screen.getByRole('button', { name: 'Использовать' }))
    await waitFor(() => expect(window.crTools.activateCaptureProfile).toHaveBeenCalled())

    statusRefresh.resolve({ configured: true, revision: 1, sourceLabel: 'Emulator 1' })
    profilesRefresh.resolve(staleProfiles)
    await Promise.resolve()

    await waitFor(() =>
      expect(screen.getByText('Второй').closest('article')).toHaveAttribute(
        'data-active',
        'true',
      ),
    )
  })

  it('creates a profile draft through an in-app dialog', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Захват' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить профиль' }))

    const dialog = screen.getByRole('dialog', { name: 'Новый профиль' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: 'Второй аккаунт' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }))

    expect(dialog).not.toBeInTheDocument()
    expect(screen.getByText(/Настройка:/)).toHaveTextContent('Второй аккаунт')
  })

  it('closes the profile dialog with Escape and restores trigger focus', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Захват' }))
    const trigger = await screen.findByRole('button', { name: 'Добавить профиль' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Новый профиль' })

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('duplicates a profile and enters source rebinding without browser prompts', async () => {
    const primary = {
      profileId: '00000000-0000-4000-8000-000000000001',
      profileName: 'Основной',
      isActive: true,
      sourceLabel: 'BlueStacks 1',
    }
    const duplicate = {
      ...primary,
      profileId: '00000000-0000-4000-8000-000000000002',
      profileName: 'Второй аккаунт',
      isActive: false,
      sourceLabel: 'BlueStacks 1',
    }
    vi.mocked(window.crTools.getCaptureProfiles).mockResolvedValue({
      revision: 1,
      activeProfileId: primary.profileId,
      profiles: [primary] as never,
    })
    const monitor = await window.crTools.getMonitorView()
    vi.mocked(window.crTools.duplicateCaptureProfile).mockResolvedValue({
      profiles: {
        revision: 2,
        activeProfileId: primary.profileId,
        profiles: [primary, duplicate] as never,
      },
      monitor,
      capture: { configured: true, revision: 1, sourceLabel: 'BlueStacks 1' },
    })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Захват' }))
    const duplicateTrigger = await screen.findByRole('button', {
      name: 'Дублировать Основной',
    })
    duplicateTrigger.focus()
    fireEvent.click(duplicateTrigger)
    fireEvent.change(screen.getByRole('textbox', { name: 'Название' }), {
      target: { value: duplicate.profileName },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Создать копию' }))

    await waitFor(() =>
      expect(window.crTools.duplicateCaptureProfile).toHaveBeenCalledWith({
        profileId: primary.profileId,
        profileName: duplicate.profileName,
        expectedRevision: 1,
      }),
    )
    await waitFor(() =>
      expect(screen.getByText(/Перепривязка:/)).toHaveTextContent(duplicate.profileName),
    )
    expect(duplicateTrigger).toHaveFocus()
  })

  it('shows update availability in the global shell', async () => {
    vi.mocked(window.crTools.getUpdateView).mockResolvedValue({
      state: 'AVAILABLE',
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      critical: false,
      releaseNotes: ['Улучшена стабильность'],
      progress: null,
      error: null,
    })
    render(<App />)

    const indicator = await screen.findByRole('button', { name: 'Доступно обновление' })
    fireEvent.click(indicator)

    expect(screen.getByRole('heading', { name: 'Настройки приложения' })).toBeVisible()
  })

  it('applies reduced motion from strict application settings', async () => {
    vi.mocked(window.crTools.getAppSettings).mockResolvedValue({
      reducedMotion: true,
      launchAtStartup: false,
      diagnosticsEnabled: false,
    })
    const view = render(<App />)
    await screen.findAllByText('operator')
    await waitFor(() => expect(document.documentElement).toHaveClass('reduced-motion'))
    view.unmount()
    expect(document.documentElement).not.toHaveClass('reduced-motion')
  })

  it('keeps successful bootstrap slices visible and retries a failed slice', async () => {
    vi.mocked(window.crTools.getMonitorView)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        state: 'STOPPED',
        preferences: { searchMode: 'fast', deckMode: 'pol' },
        readiness: {
          authenticated: true,
          captureConfigured: false,
          sourceAvailable: null,
        },
        error: null,
        startedAt: null,
        stats: {
          triggers: 0,
          requests: 0,
          droppedActions: 0,
          playersFound: 0,
          playersNotFound: 0,
          recognitionFailures: 0,
          serviceErrors: 0,
        },
        results: [],
      })

    render(<App />)

    expect(await screen.findByText('Часть данных недоступна')).toBeVisible()
    expect(screen.getAllByText('operator').length).toBeGreaterThan(0)
    expect(
      screen.getByRole('heading', { name: 'Проверяем готовность системы' }),
    ).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }))

    expect(
      await screen.findByRole('heading', { name: 'Выберите источник захвата' }),
    ).toBeVisible()
    await waitFor(() =>
      expect(screen.queryByText('Часть данных недоступна')).not.toBeInTheDocument(),
    )
    expect(
      vi.mocked(window.crTools.getMonitorView).mock.calls.length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('shows a failed hello handshake and clears it after retry', async () => {
    vi.mocked(window.crTools.hello).mockRejectedValueOnce(new Error('protocol'))
    render(<App />)

    expect(await screen.findByText(/совместимость приложения/)).toBeVisible()
    expect(screen.getAllByText('operator').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }))

    await waitFor(() =>
      expect(screen.queryByText(/совместимость приложения/)).not.toBeInTheDocument(),
    )
    expect(window.crTools.hello).toHaveBeenCalledTimes(2)
  })

  it('merges a widget patch into status refreshed immediately before mutation', async () => {
    const staleStatus = {
      settings: {
        autoOpen: true,
        alwaysOnTop: true,
        locked: false,
        opacity: 0.96,
        compactMode: false,
        bounds: { x: null, y: null, width: 420, height: 560 },
      },
      visible: false,
      hasResult: false,
    }
    const statusOnEntry = {
      settings: {
        ...staleStatus.settings,
        alwaysOnTop: false,
        bounds: { x: 20, y: 30, width: 500, height: 640 },
      },
      visible: true,
      hasResult: true,
    }
    const statusBeforeMutation = {
      settings: {
        ...statusOnEntry.settings,
        locked: true,
        bounds: { x: 40, y: 50, width: 610, height: 700 },
      },
      visible: true,
      hasResult: true,
    }
    vi.mocked(window.crTools.getWidgetStatus)
      .mockResolvedValueOnce(staleStatus)
      .mockResolvedValueOnce(statusOnEntry)
      .mockResolvedValueOnce(statusBeforeMutation)

    render(<App />)
    await screen.findAllByText('operator')
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    await waitFor(() => expect(window.crTools.getWidgetStatus).toHaveBeenCalledTimes(2))

    fireEvent.click(
      screen.getByRole('checkbox', { name: /^Открывать при найденном игроке/ }),
    )

    await waitFor(() =>
      expect(window.crTools.updateWidgetSettings).toHaveBeenCalledTimes(1),
    )
    expect(window.crTools.updateWidgetSettings).toHaveBeenCalledWith({
      ...statusBeforeMutation.settings,
      autoOpen: false,
    })
  })

  it('provides accessible names for compact navigation and logout controls', async () => {
    render(<App />)
    await screen.findAllByText('operator')

    for (const name of ['Главная', 'Захват', 'Стример', 'Настройки']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-label', name)
    }
    expect(screen.getByRole('button', { name: 'Выйти из профиля' })).toHaveAttribute(
      'aria-label',
      'Выйти из профиля',
    )
  })

  it('clears capture selection when search or source tab changes the visible list', async () => {
    const revision = 'c'.repeat(32)
    vi.mocked(window.crTools.listCaptureSources).mockResolvedValue({
      revision,
      expiresAt: Date.now() + 30_000,
      sources: [
        {
          sourceKey: 'a'.repeat(32),
          revision,
          kind: 'window',
          label: 'Clash Royale',
          detail: 'Основное окно',
          captureSupported: true,
          unavailableReason: null,
          preview: null,
        },
        {
          sourceKey: 'b'.repeat(32),
          revision,
          kind: 'display',
          label: 'Монитор 1',
          detail: '1920 × 1080',
          captureSupported: true,
          unavailableReason: null,
          preview: null,
        },
      ],
    })

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Захват' }))

    fireEvent.click(await screen.findByRole('button', { name: /Clash Royale/ }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Продолжить к настройке' }),
      ).toBeEnabled(),
    )
    expect(window.crTools.prepareCaptureSource).toHaveBeenCalledWith({
      sourceKey: 'a'.repeat(32),
      revision,
    })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск источника' }), {
      target: { value: 'другое окно' },
    })
    expect(screen.getByRole('button', { name: 'Продолжить к настройке' })).toBeDisabled()
    expect(window.crTools.releaseCaptureSource).toHaveBeenCalledWith({
      sourceKey: 'a'.repeat(32),
      revision,
    })

    fireEvent.change(screen.getByRole('searchbox', { name: 'Поиск источника' }), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Clash Royale/ }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Продолжить к настройке' }),
      ).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('tab', { name: /Мониторы/ }))
    expect(screen.getByRole('button', { name: 'Продолжить к настройке' })).toBeDisabled()
  })
})
