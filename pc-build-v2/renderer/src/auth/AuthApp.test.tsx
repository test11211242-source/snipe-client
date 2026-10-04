// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AuthApp } from './AuthApp'

function credentialsForm(input: HTMLElement): HTMLFormElement {
  const form = input.closest('form')
  if (form === null) throw new Error('Expected a credentials form')
  return form
}

function installAuthBridge(view: unknown, overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'crToolsAuth', {
    configurable: true,
    value: {
      getView: vi.fn().mockResolvedValue(view),
      getUpdateView: vi.fn().mockResolvedValue({
        state: 'IDLE',
        currentVersion: '1.0.0',
        availableVersion: null,
        critical: false,
        releaseNotes: [],
        progress: null,
        error: null,
      }),
      ...overrides,
    },
  })
}

describe('AuthApp', () => {
  it('shows a retryable error instead of spinning forever when auth IPC fails', async () => {
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView: vi.fn().mockRejectedValue(new Error('IPC rejected')),
        retryBootstrap: vi.fn(),

        resetLogin: vi.fn(),
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
        error: null,
      })
      .mockResolvedValue({
        state: 'UNAUTHENTICATED',
        user: null,
        error: null,
      })
    Object.defineProperty(window, 'crToolsAuth', {
      configurable: true,
      value: Object.freeze({
        getView,
        retryBootstrap: vi.fn(),

        resetLogin: vi.fn(),
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

  it('opens login first, sends credentials without a key and requires a key only for registration', async () => {
    const view = { state: 'UNAUTHENTICATED', user: null, error: null }
    const register = vi.fn().mockResolvedValue({
      ...view,
      error: { message: 'Этот ключ уже привязан к другому аккаунту' },
    })
    const login = vi.fn().mockResolvedValue(view)
    installAuthBridge(view, { register, login })
    render(<AuthApp />)
    await screen.findByRole('heading', { name: 'Вход в CR Tools' })
    expect(screen.queryByLabelText('Ключ доступа')).not.toBeInTheDocument()
    expect(screen.getByText(/Уже зарегистрированы на телефоне или сайте/)).toBeVisible()
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'operator@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Пароль'), {
      target: { value: 'password123' },
    })
    fireEvent.submit(credentialsForm(screen.getByLabelText('Email')))
    await vi.waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: 'operator@example.com',
        password: 'password123',
      }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Регистрация' }))
    const key = screen.getByLabelText('Ключ доступа')
    expect(key).toBeRequired()
    expect(key).toHaveAccessibleDescription(/Ключ покупается у администратора/)
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'operator@example.com' },
    })
    fireEvent.change(screen.getByLabelText('Имя пользователя'), {
      target: { value: 'operator' },
    })
    fireEvent.change(screen.getByLabelText('Пароль'), {
      target: { value: 'password123' },
    })
    fireEvent.change(key, { target: { value: 'test_key-123' } })
    fireEvent.submit(credentialsForm(key))
    expect(
      await screen.findByText('Этот ключ уже привязан к другому аккаунту'),
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Создание аккаунта' })).toBeVisible()
    expect(register).toHaveBeenCalledWith({
      email: 'operator@example.com',
      username: 'operator',
      password: 'password123',
      inviteKey: 'test_key-123',
    })
  })

  it('returns from a blocked account to a clean login form', async () => {
    const message = 'Подписка не активна. Продлите ключ доступа.'
    const resetLogin = vi
      .fn()
      .mockResolvedValue({ state: 'UNAUTHENTICATED', user: null, error: null })
    installAuthBridge(
      { state: 'BLOCKED', user: null, error: { message } },
      { resetLogin },
    )
    render(<AuthApp />)
    expect(await screen.findByText(message)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Войти в другой аккаунт' }))
    expect(await screen.findByRole('heading', { name: 'Вход в CR Tools' })).toBeVisible()
    expect(screen.queryByText(message)).not.toBeInTheDocument()
    expect(resetLogin).toHaveBeenCalledOnce()
  })

  it('shows a prominent replaced-session notice above the login fields', async () => {
    const message = 'Выполнен вход на другом устройстве'
    installAuthBridge({
      state: 'UNAUTHENTICATED',
      user: null,
      error: { code: 'UNAUTHORIZED', message },
    })
    render(<AuthApp />)
    const heading = await screen.findByRole('heading', { name: 'Вы вышли из аккаунта' })
    expect(heading.closest('[role="alert"]')).toHaveTextContent(message)
    expect(screen.getByRole('heading', { name: 'Вход в CR Tools' })).toBeVisible()
    expect(screen.getAllByText(message)).toHaveLength(1)
  })

  it('shows a wrong-password detail as a form error', async () => {
    installAuthBridge({
      state: 'UNAUTHENTICATED',
      user: null,
      error: { code: 'UNAUTHORIZED', message: 'Неверный email или пароль' },
    })
    render(<AuthApp />)
    expect(await screen.findByText('Неверный email или пароль')).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Вы вышли из аккаунта' }),
    ).not.toBeInTheDocument()
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
          error: null,
        }),
        retryBootstrap: vi.fn(),

        resetLogin: vi.fn(),
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
          error: null,
        }),
        retryBootstrap: vi.fn(),

        resetLogin: vi.fn(),
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
