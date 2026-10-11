// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { AuthView } from '../../../shared/models/auth'
import type { UpdateView } from '../../../shared/models/update'
import { AuthApp } from './AuthApp'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const unauthenticated: AuthView = { state: 'UNAUTHENTICATED', user: null, error: null }
const idle: UpdateView = {
  state: 'IDLE',
  currentVersion: '1.0.0',
  availableVersion: null,
  critical: false,
  releaseNotes: [],
  progress: null,
  error: null,
}
const available: UpdateView = {
  ...idle,
  state: 'AVAILABLE',
  availableVersion: '1.1.0',
  releaseNotes: ['Исправлен вход'],
}

function authError(
  code: NonNullable<AuthView['error']>['code'],
  message: string,
  retryable = false,
): AuthView {
  return {
    state: 'UNAUTHENTICATED',
    user: null,
    error: { code, message, retryable, status: null },
  }
}

interface AuthBridge {
  getView: Mock
  retryBootstrap: Mock
  resetLogin: Mock
  login: Mock
  register: Mock
  getUpdateView: Mock
  checkForUpdate: Mock
  downloadUpdate: Mock
  cancelUpdate: Mock
  installUpdate: Mock
}

function installAuth(
  view: AuthView | Error,
  update: UpdateView = idle,
  overrides: Partial<AuthBridge> = {},
): AuthBridge {
  const bridge: AuthBridge = {
    getView: vi.fn(() =>
      view instanceof Error ? Promise.reject(view) : Promise.resolve(view),
    ),
    retryBootstrap: vi.fn(() => Promise.resolve(unauthenticated)),
    resetLogin: vi.fn(() => Promise.resolve(unauthenticated)),
    login: vi.fn(() => Promise.resolve(unauthenticated)),
    register: vi.fn(() => Promise.resolve(unauthenticated)),
    getUpdateView: vi.fn(() => Promise.resolve(update)),
    checkForUpdate: vi.fn(() => Promise.resolve(update)),
    downloadUpdate: vi.fn(() => Promise.resolve(update)),
    cancelUpdate: vi.fn(() => Promise.resolve(update)),
    installUpdate: vi.fn(() => Promise.resolve(update)),
    ...overrides,
  }
  Object.defineProperty(window, 'crToolsAuth', { configurable: true, value: bridge })
  return bridge
}

const field = (name: string): HTMLElement => screen.getByLabelText(name)
function type(name: string, value: string): void {
  fireEvent.change(field(name), { target: { value } })
}

describe('auth window: bootstrap', () => {
  it('shows a retryable error instead of spinning forever when auth IPC fails', async () => {
    installAuth(new Error('IPC rejected'))
    render(<AuthApp />)
    expect(
      await screen.findByRole('heading', { name: 'Не удалось проверить вход' }),
    ).toBeVisible()
    expect(
      screen.getByText('Не удалось получить состояние авторизации от приложения.'),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeVisible()
  })

  it('shows the checking state until the initial auth check completes', async () => {
    const getView = vi
      .fn()
      .mockResolvedValueOnce({ state: 'BOOTSTRAPPING', user: null, error: null })
      .mockResolvedValueOnce({ state: 'BOOTSTRAPPING', user: null, error: null })
      .mockResolvedValue(unauthenticated)
    installAuth(unauthenticated, idle, { getView })
    render(<AuthApp />)
    expect(await screen.findByText('Проверяем вход')).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'С возвращением' })).toBeVisible()
    expect(getView.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('offers retry and a fresh login after a failed check', async () => {
    const bridge = installAuth({
      state: 'ERROR',
      user: null,
      error: {
        code: 'NETWORK_UNAVAILABLE',
        message: 'Нет связи с сервером.',
        retryable: true,
        status: null,
      },
    })
    render(<AuthApp />)
    expect(await screen.findByText('Нет связи с сервером.')).toBeVisible()
    expect(screen.getByText('Нет связи')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(bridge.retryBootstrap).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('heading', { name: 'С возвращением' })).toBeVisible()
  })

  it('offers only a fresh login when the failure is not retryable', async () => {
    const bridge = installAuth({
      state: 'ERROR',
      user: null,
      error: {
        code: 'SECRET_INVALID',
        message: 'Сохранённый вход повреждён.',
        retryable: false,
        status: null,
      },
    })
    render(<AuthApp />)
    await screen.findByText('Сохранённый вход повреждён.')
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Войти заново' }))
    await waitFor(() => expect(bridge.resetLogin).toHaveBeenCalledTimes(1))
  })

  it('returns from a blocked account to a clean login form', async () => {
    const message = 'Подписка не активна. Продлите ключ доступа.'
    const bridge = installAuth({
      state: 'BLOCKED',
      user: null,
      error: { code: 'FORBIDDEN', message, retryable: false, status: 403 },
    })
    render(<AuthApp />)
    expect(
      await screen.findByRole('heading', { name: 'Доступ заблокирован' }),
    ).toBeVisible()
    expect(screen.getByText(message)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Войти в другой аккаунт' }))
    expect(await screen.findByRole('heading', { name: 'С возвращением' })).toBeVisible()
    expect(screen.queryByText(message)).toBeNull()
    expect(bridge.resetLogin).toHaveBeenCalledOnce()
  })
})

describe('auth window: login and registration', () => {
  it('signs in with email and password only, after checking the fields', async () => {
    const bridge = installAuth(unauthenticated)
    render(<AuthApp />)
    await screen.findByRole('heading', { name: 'С возвращением' })
    expect(screen.queryByLabelText('Ключ приглашения')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByText('Нужна запись вида name@mail.ru')).toBeVisible()
    expect(screen.getByText('Введите пароль')).toBeVisible()
    expect(bridge.login).not.toHaveBeenCalled()

    type('Почта', 'operator@example.com')
    type('Пароль', 'password123')
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() =>
      expect(bridge.login).toHaveBeenCalledWith({
        email: 'operator@example.com',
        password: 'password123',
      }),
    )
  })

  it('registers with the invite key and validates it first', async () => {
    const bridge = installAuth(unauthenticated)
    render(<AuthApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Регистрация' }))
    expect(
      await screen.findByRole('heading', { name: 'Создание аккаунта' }),
    ).toBeVisible()
    type('Почта', 'operator@example.com')
    type('Имя пользователя', 'o')
    type('Ключ приглашения', 'abc!')
    type('Пароль', 'short')
    fireEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
    expect(await screen.findByText('Имя — от 2 до 50 символов')).toBeVisible()
    expect(screen.getByText(/Ключ — от 8 до 50 символов/)).toBeVisible()
    expect(
      screen.getByText('Пароль не короче 8 символов', { selector: 'span' }),
    ).toBeVisible()
    expect(bridge.register).not.toHaveBeenCalled()

    type('Имя пользователя', 'operator')
    type('Ключ приглашения', ' test_key-123 ')
    type('Пароль', 'password123')
    fireEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }))
    await waitFor(() =>
      expect(bridge.register).toHaveBeenCalledWith({
        email: 'operator@example.com',
        username: 'operator',
        password: 'password123',
        inviteKey: ' test_key-123 ',
      }),
    )
  })

  it('keeps everything typed after a failed attempt and shows what to do', async () => {
    const bridge = installAuth(unauthenticated, idle, {
      login: vi.fn(() =>
        Promise.resolve(authError('UNAUTHORIZED', 'Неверный email или пароль')),
      ),
    })
    render(<AuthApp />)
    await screen.findByRole('heading', { name: 'С возвращением' })
    type('Почта', 'operator@example.com')
    type('Пароль', 'wrong-password')
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByText('Неверный email или пароль')).toBeVisible()
    expect(screen.getByText(/Проверьте раскладку и Caps Lock/)).toBeVisible()
    expect(field('Почта')).toHaveValue('operator@example.com')
    expect(field('Пароль')).toHaveValue('wrong-password')
    expect(bridge.login).toHaveBeenCalledTimes(1)
  })

  it('network error offers a retry that sends the same credentials again', async () => {
    const login = vi
      .fn()
      .mockResolvedValueOnce(
        authError('NETWORK_UNAVAILABLE', 'Нет связи с сервером', true),
      )
      .mockResolvedValue(unauthenticated)
    installAuth(unauthenticated, idle, { login })
    render(<AuthApp />)
    await screen.findByRole('heading', { name: 'С возвращением' })
    type('Почта', 'operator@example.com')
    type('Пароль', 'password123')
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    expect(await screen.findByText('Нет связи с сервером')).toBeVisible()
    expect(screen.getByText(/Введённые данные сохранены/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(login).toHaveBeenCalledTimes(2))
    expect(login).toHaveBeenLastCalledWith({
      email: 'operator@example.com',
      password: 'password123',
    })
  })

  it('shows a replaced session as its own notice', async () => {
    const message = 'Выполнен вход на другом устройстве'
    installAuth(authError('UNAUTHORIZED', message))
    render(<AuthApp />)
    expect(await screen.findByText('Вы вышли из аккаунта')).toBeVisible()
    expect(screen.getAllByText(message)).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'С возвращением' })).toBeVisible()
  })

  it('reveals the password only on request', async () => {
    installAuth(unauthenticated)
    render(<AuthApp />)
    await screen.findByRole('heading', { name: 'С возвращением' })
    expect(field('Пароль')).toHaveAttribute('type', 'password')
    fireEvent.click(screen.getByRole('button', { name: 'Показать пароль' }))
    expect(field('Пароль')).toHaveAttribute('type', 'text')
  })
})

describe('auth window: updates', () => {
  it('requires a critical update: download, then install, with the error shown', async () => {
    const critical: UpdateView = { ...available, critical: true }
    const ready: UpdateView = { ...critical, state: 'READY' }
    const failedInstall: UpdateView = {
      ...ready,
      error: {
        code: 'INSTALLER_HELPER_EXITED',
        message: 'Установщик не запустился.',
        retryable: true,
      },
    }
    const bridge = installAuth(unauthenticated, critical, {
      downloadUpdate: vi.fn(() => Promise.resolve(ready)),
      installUpdate: vi.fn(() => Promise.resolve(failedInstall)),
    })
    render(<AuthApp />)
    expect(
      await screen.findByRole('heading', { name: 'Нужно обновить CR Tools' }),
    ).toBeVisible()
    expect(screen.getByText('Исправлен вход')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Войти' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Скачать и обновить' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Перезапустить для установки' }),
    )
    await waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledOnce())
    expect(await screen.findByText(/Установщик не запустился/)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Перезапустить для установки' }),
    ).toBeVisible()
  })

  it('shows progress for a required update and lets the user cancel', async () => {
    const downloading: UpdateView = {
      ...available,
      critical: true,
      state: 'DOWNLOADING',
      progress: { downloadedBytes: 56 * 1048576, totalBytes: 148 * 1048576, percent: 38 },
    }
    const bridge = installAuth(unauthenticated, downloading)
    render(<AuthApp />)
    expect(await screen.findByText('Скачано 56 МБ из 148 МБ')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Скачиваем…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Отменить загрузку' }))
    await waitFor(() => expect(bridge.cancelUpdate).toHaveBeenCalledOnce())
  })

  it('an optional update is only a strip above the form', async () => {
    const bridge = installAuth(unauthenticated, available)
    render(<AuthApp />)
    expect(await screen.findByText('Доступна версия 1.1.0')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'С возвращением' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Скачать' }))
    await waitFor(() => expect(bridge.downloadUpdate).toHaveBeenCalledOnce())
  })

  it('shows the installed version in the footer', async () => {
    installAuth(unauthenticated)
    render(<AuthApp />)
    expect(await screen.findByText('Версия 1.0.0')).toBeVisible()
  })
})
