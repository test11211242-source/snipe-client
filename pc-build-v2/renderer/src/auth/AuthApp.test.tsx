// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AuthApp } from './AuthApp'

describe('AuthApp', () => {
  it('shows a retryable error instead of spinning forever when auth IPC fails', async () => {
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockRejectedValue(new Error('IPC rejected')),
        retryBootstrap: vi.fn(),
        checkInvite: vi.fn(),
        activateInvite: vi.fn(),
        login: vi.fn(),
        register: vi.fn(),
        getUpdateView: vi.fn().mockResolvedValue({
          state: 'IDLE',
          currentVersion: '1.0.0',
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
      }),
    })

    render(<AuthApp />)
    expect(
      await screen.findByRole('heading', { name: 'Не удалось продолжить' }),
    ).toBeVisible()
    expect(
      screen.getByText('Не удалось получить состояние авторизации от приложения.'),
    ).toBeVisible()
  })

  it('refreshes the bootstrap view until the initial auth check completes', async () => {
    const getView = vi
      .fn()
      .mockResolvedValueOnce({
        state: 'BOOTSTRAPPING',
        user: null,
        deviceHint: null,
        error: null,
      })
      .mockResolvedValue({
        state: 'UNAUTHENTICATED',
        user: null,
        deviceHint: '12345678...abcd',
        error: null,
      })
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView,
        retryBootstrap: vi.fn(),
        checkInvite: vi.fn(),
        activateInvite: vi.fn(),
        login: vi.fn(),
        register: vi.fn(),
        getUpdateView: vi.fn().mockResolvedValue({
          state: 'IDLE',
          currentVersion: '1.0.0',
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
      }),
    })

    render(<AuthApp />)
    expect(await screen.findByText('Проверяем защищённый сеанс')).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Вход в CR Tools' })).toBeVisible()
    expect(getView).toHaveBeenCalledTimes(2)
  })

  it('renders the invite gate and advances to accessible credentials', async () => {
    const activateInvite = vi.fn().mockResolvedValue({
      state: 'UNAUTHENTICATED',
      user: null,
      deviceHint: '12345678...abcd',
      error: null,
    })
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockResolvedValue({
          state: 'INVITE_REQUIRED',
          user: null,
          deviceHint: '12345678...abcd',
          error: null,
        }),
        retryBootstrap: vi.fn(),
        checkInvite: vi.fn(),
        activateInvite,
        login: vi.fn(),
        register: vi.fn(),
        getUpdateView: vi.fn().mockResolvedValue({
          state: 'IDLE',
          currentVersion: '1.0.0',
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
      }),
    })
    render(<AuthApp />)
    const input = await screen.findByLabelText('Инвайт-код')
    fireEvent.change(input, { target: { value: 'INVITE_123' } })
    const form = input.closest('form')
    if (form === null) throw new Error('Invite form is missing')
    fireEvent.submit(form)
    expect(await screen.findByRole('heading', { name: 'Вход в CR Tools' })).toBeVisible()
    expect(screen.getByLabelText('Email')).toBeVisible()
    expect(activateInvite).toHaveBeenCalledWith({ inviteCode: 'INVITE_123' })
  })

  it('downloads and installs an update without an authenticated session', async () => {
    const available = {
      state: 'AVAILABLE' as const,
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      critical: true,
      releaseNotes: ['Login compatibility fix'],
      progress: null,
      error: null,
    }
    const ready = { ...available, state: 'READY' as const }
    const failedInstall = {
      ...ready,
      error: {
        code: 'INSTALLER_HELPER_EXITED',
        message: 'English fallback',
        retryable: true,
      },
    }
    const downloadUpdate = vi.fn().mockResolvedValue(ready)
    const installUpdate = vi.fn().mockResolvedValue(failedInstall)
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockResolvedValue({
          state: 'UNAUTHENTICATED',
          user: null,
          deviceHint: '12345678...abcd',
          error: null,
        }),
        retryBootstrap: vi.fn(),
        checkInvite: vi.fn(),
        activateInvite: vi.fn(),
        login: vi.fn(),
        register: vi.fn(),
        getUpdateView: vi.fn().mockResolvedValue(available),
        checkForUpdate: vi.fn(),
        downloadUpdate,
        cancelUpdate: vi.fn(),
        installUpdate,
      }),
    })

    render(<AuthApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать обновление' }))
    expect(await screen.findByText('Версия 1.1.0 готова к установке')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Установить обновление' }))
    await vi.waitFor(() => expect(installUpdate).toHaveBeenCalledOnce())
    expect(
      await screen.findByText(
        'Системный компонент завершился до запуска установщика. (INSTALLER_HELPER_EXITED)',
      ),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Установить обновление' })).toBeVisible()
    expect(downloadUpdate).toHaveBeenCalledOnce()
  })

  it('shows download progress and permits cancellation from the auth screen', async () => {
    const available = {
      state: 'AVAILABLE' as const,
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      critical: false,
      releaseNotes: [],
      progress: null,
      error: null,
    }
    const downloading = {
      ...available,
      state: 'DOWNLOADING' as const,
      progress: { downloadedBytes: 25, totalBytes: 100, percent: 25 },
    }
    let completeDownload: ((view: typeof available) => void) | undefined
    const downloadUpdate = vi.fn(
      () =>
        new Promise<typeof available>((resolve) => {
          completeDownload = resolve
        }),
    )
    const cancelUpdate = vi.fn(() => {
      completeDownload?.(available)
      return Promise.resolve(available)
    })
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockResolvedValue({
          state: 'UNAUTHENTICATED',
          user: null,
          deviceHint: '12345678...abcd',
          error: null,
        }),
        retryBootstrap: vi.fn(),
        checkInvite: vi.fn(),
        activateInvite: vi.fn(),
        login: vi.fn(),
        register: vi.fn(),
        getUpdateView: vi
          .fn()
          .mockResolvedValueOnce(available)
          .mockResolvedValue(downloading),
        checkForUpdate: vi.fn(),
        downloadUpdate,
        cancelUpdate,
        installUpdate: vi.fn(),
      }),
    })

    render(<AuthApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать обновление' }))
    expect(await screen.findByText('Загрузка 25%')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить загрузку' }))
    await vi.waitFor(() => expect(cancelUpdate).toHaveBeenCalledOnce())
    expect(downloadUpdate).toHaveBeenCalledOnce()
  })
})
