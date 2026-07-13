// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'

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
        listCaptureSources: vi.fn().mockResolvedValue({
          revision: 'a'.repeat(32),
          expiresAt: Date.now() + 30_000,
          sources: [],
        }),
        getCapturePreview: vi.fn(),
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
        updateWidgetSettings: vi.fn(),
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
      screen.getByRole('heading', { name: 'Получаем состояние системы' }),
    ).toBeVisible()
    expect((await screen.findAllByText('operator')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Realtime подключается').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Выбрать источник' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Захват' }))
    expect(screen.getByRole('heading', { name: 'Источник захвата' })).toBeVisible()
  })

  it('shows the honest unsigned-publisher warning in update settings', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    expect(await screen.findByText(/Windows может показать предупреждение/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeVisible()
    expect(screen.getByText(/Данные автоматически не отправляются/)).toBeVisible()
  })

  it('applies reduced motion from strict application settings', async () => {
    vi.mocked(window.crTools.getAppSettings).mockResolvedValue({
      reducedMotion: true,
      launchAtStartup: false,
      diagnosticsEnabled: false,
    })
    const view = render(<App />)
    await screen.findAllByText('operator')
    expect(document.documentElement).toHaveClass('reduced-motion')
    view.unmount()
    expect(document.documentElement).not.toHaveClass('reduced-motion')
  })
})
