import { KeyRound, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useState, type SyntheticEvent } from 'react'

import type { AuthView } from '../../../shared/models/auth'

type FormMode = 'login' | 'register'
type FormSubmitEvent = SyntheticEvent<HTMLFormElement, SubmitEvent>

function readFormString(data: FormData, key: string): string {
  const value = data.get(key)
  return typeof value === 'string' ? value : ''
}

function ipcErrorView(): AuthView {
  return {
    state: 'ERROR',
    user: null,
    deviceHint: null,
    error: {
      code: 'UNKNOWN',
      message: 'Не удалось получить состояние авторизации от приложения.',
      retryable: true,
      status: null,
    },
  }
}

export function AuthApp(): React.JSX.Element {
  const [view, setView] = useState<AuthView | null>(null)
  const [mode, setMode] = useState<FormMode>('login')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshView = async (): Promise<void> => {
      try {
        const next = await window.crToolsAuth.getView()
        if (!active) return
        setView(next)
        if (next.state === 'BOOTSTRAPPING') {
          timer = setTimeout(() => void refreshView(), 250)
        }
      } catch {
        if (active) setView(ipcErrorView())
      }
    }
    void refreshView()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  const run = async (operation: () => Promise<AuthView>): Promise<void> => {
    setPending(true)
    try {
      setView(await operation())
    } catch {
      setView(ipcErrorView())
    } finally {
      setPending(false)
    }
  }

  const submitInvite = (event: FormSubmitEvent): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const inviteCode = readFormString(data, 'inviteCode')
    void run(() => window.crToolsAuth.activateInvite({ inviteCode }))
  }

  const submitCredentials = (event: FormSubmitEvent): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const email = readFormString(data, 'email')
    const password = readFormString(data, 'password')
    if (mode === 'register') {
      const username = readFormString(data, 'username')
      void run(() => window.crToolsAuth.register({ email, username, password }))
    } else {
      void run(() => window.crToolsAuth.login({ email, password }))
    }
  }

  const state = view?.state ?? 'BOOTSTRAPPING'
  const isLoading = pending || state === 'BOOTSTRAPPING' || state === 'AUTHENTICATED'

  return (
    <main className="auth-workspace">
      <section className="auth-context" aria-labelledby="auth-product-title">
        <div className="auth-brand">
          <div className="brand-mark" aria-hidden="true">
            CR
          </div>
          <div>
            <span>OPERATIONAL CLIENT</span>
            <strong id="auth-product-title">CR Tools V2</strong>
          </div>
        </div>
        <div className="auth-copy">
          <span className="eyebrow">ЗАЩИЩЁННЫЙ ДОСТУП</span>
          <h1>Рабочее пространство начинается с доверенного сеанса.</h1>
          <p>
            Учётные данные передаются только production API. Токены и полный идентификатор
            устройства недоступны интерфейсу.
          </p>
        </div>
        <div className="auth-security-note">
          <ShieldCheck aria-hidden="true" size={19} />
          <div>
            <strong>Windows protected storage</strong>
            <span>Refresh token защищён системным шифрованием</span>
          </div>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-form-title">
        <div className="auth-panel-inner">
          {state === 'INVITE_REQUIRED' ? (
            <InviteForm
              pending={pending}
              deviceHint={view?.deviceHint ?? null}
              error={view?.error?.message ?? null}
              onSubmit={submitInvite}
            />
          ) : state === 'BLOCKED' ? (
            <StateMessage
              tone="danger"
              title="Доступ заблокирован"
              description={
                view?.error?.message ?? 'Сервер запретил доступ для этой учётной записи.'
              }
            />
          ) : state === 'ERROR' ? (
            <StateMessage
              tone="danger"
              title="Не удалось продолжить"
              description={view?.error?.message ?? 'Произошла ошибка авторизации.'}
              actionLabel={
                view?.error?.retryable === true ? 'Повторить проверку' : undefined
              }
              onAction={() => void run(() => window.crToolsAuth.retryBootstrap())}
            />
          ) : isLoading ? (
            <div className="auth-loading" role="status" aria-live="polite">
              <span className="auth-spinner" aria-hidden="true" />
              <h2 id="auth-form-title">Проверяем защищённый сеанс</h2>
              <p>Соединение с production API и проверка устройства.</p>
            </div>
          ) : (
            <CredentialsForm
              mode={mode}
              pending={pending}
              error={view?.error?.message ?? null}
              onModeChange={setMode}
              onSubmit={submitCredentials}
            />
          )}
        </div>
      </section>
    </main>
  )
}

function InviteForm({
  pending,
  deviceHint,
  error,
  onSubmit,
}: {
  pending: boolean
  deviceHint: string | null
  error: string | null
  onSubmit: (event: FormSubmitEvent) => void
}): React.JSX.Element {
  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <div className="form-icon">
        <KeyRound aria-hidden="true" size={22} />
      </div>
      <span className="eyebrow">ЭТАП 01 / ДОПУСК</span>
      <h2 id="auth-form-title">Активируйте инвайт</h2>
      <p className="form-description">Код будет привязан к текущему устройству.</p>
      <label htmlFor="invite-code">Инвайт-код</label>
      <input
        id="invite-code"
        name="inviteCode"
        autoComplete="off"
        minLength={8}
        maxLength={50}
        pattern="[A-Za-z0-9_-]+"
        required
        autoFocus
      />
      <div className="form-error" role="alert" aria-live="assertive">
        {error}
      </div>
      <button className="primary-button" disabled={pending} type="submit">
        {pending ? 'Проверяем...' : 'Активировать доступ'}
      </button>
      <div className="device-hint">
        Устройство: <code>{deviceHint ?? 'проверяется'}</code>
      </div>
    </form>
  )
}

function CredentialsForm({
  mode,
  pending,
  error,
  onModeChange,
  onSubmit,
}: {
  mode: FormMode
  pending: boolean
  error: string | null
  onModeChange: (mode: FormMode) => void
  onSubmit: (event: FormSubmitEvent) => void
}): React.JSX.Element {
  return (
    <form className="auth-form" onSubmit={onSubmit}>
      <div className="form-icon">
        <UserRound aria-hidden="true" size={22} />
      </div>
      <span className="eyebrow">ЭТАП 02 / УЧЁТНАЯ ЗАПИСЬ</span>
      <h2 id="auth-form-title">
        {mode === 'login' ? 'Вход в CR Tools' : 'Создание аккаунта'}
      </h2>
      <div className="mode-switch" role="group" aria-label="Режим авторизации">
        <button
          type="button"
          data-active={mode === 'login'}
          onClick={() => onModeChange('login')}
        >
          Вход
        </button>
        <button
          type="button"
          data-active={mode === 'register'}
          onClick={() => onModeChange('register')}
        >
          Регистрация
        </button>
      </div>
      {mode === 'register' && (
        <>
          <label htmlFor="username">Имя пользователя</label>
          <input
            id="username"
            name="username"
            minLength={2}
            maxLength={50}
            autoComplete="username"
            required
          />
        </>
      )}
      <label htmlFor="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        maxLength={254}
        autoComplete="email"
        required
        autoFocus
      />
      <label htmlFor="password">Пароль</label>
      <input
        id="password"
        name="password"
        type="password"
        minLength={mode === 'register' ? 8 : 1}
        maxLength={256}
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        required
      />
      <div className="form-error" role="alert" aria-live="assertive">
        {error}
      </div>
      <button className="primary-button" disabled={pending} type="submit">
        <LockKeyhole aria-hidden="true" size={16} />
        {pending ? 'Отправляем...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
      </button>
    </form>
  )
}

function StateMessage({
  title,
  description,
  tone = 'neutral',
  actionLabel,
  onAction,
}: {
  title: string
  description: string
  tone?: 'neutral' | 'danger'
  actionLabel?: string | undefined
  onAction?: (() => void) | undefined
}): React.JSX.Element {
  return (
    <div className="auth-state" data-tone={tone} role="alert" aria-live="assertive">
      <span className="auth-state-mark" aria-hidden="true">
        !
      </span>
      <h2 id="auth-form-title">{title}</h2>
      <p>{description}</p>
      {actionLabel !== undefined && onAction !== undefined && (
        <button className="primary-button" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}
