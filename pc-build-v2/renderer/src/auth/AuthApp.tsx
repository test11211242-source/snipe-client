import { LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useState, type SyntheticEvent } from 'react'

import type { AuthView } from '../../../shared/models/auth'
import type { UpdateView } from '../../../shared/models/update'
import { publicErrorMessage } from '../app/format'

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
  const [updateView, setUpdateView] = useState<UpdateView | null>(null)
  const [updateUnavailable, setUpdateUnavailable] = useState(false)
  const [updatePending, setUpdatePending] = useState(false)

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

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshUpdate = async (): Promise<void> => {
      let delay = 5_000
      try {
        const next = await window.crToolsAuth.getUpdateView()
        if (!active) return
        setUpdateView(next)
        setUpdateUnavailable(false)
        if (next.state === 'CHECKING' || next.state === 'DOWNLOADING') delay = 1_000
      } catch {
        if (!active) return
        setUpdateUnavailable(true)
      }
      timer = setTimeout(() => void refreshUpdate(), delay)
    }
    void refreshUpdate()
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

  const runUpdate = async (
    operation: () => Promise<UpdateView>,
    background: boolean,
  ): Promise<void> => {
    setUpdatePending(true)
    try {
      const completion = operation()
      if (background) {
        setUpdateView(await window.crToolsAuth.getUpdateView())
        void completion
          .then((next) => {
            setUpdateView(next)
            setUpdateUnavailable(false)
          })
          .catch(() => setUpdateUnavailable(true))
      } else {
        setUpdateView(await completion)
      }
      setUpdateUnavailable(false)
    } catch {
      setUpdateUnavailable(true)
    } finally {
      setUpdatePending(false)
    }
  }

  const submitCredentials = (event: FormSubmitEvent): void => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const email = readFormString(data, 'email')
    const password = readFormString(data, 'password')
    if (mode === 'register') {
      const username = readFormString(data, 'username')
      const inviteKey = readFormString(data, 'inviteKey')
      void run(() =>
        window.crToolsAuth.register({ email, username, password, inviteKey }),
      )
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
        <div className="auth-panel-stack">
          <div className="auth-panel-inner">
            {state === 'BLOCKED' ? (
              <StateMessage
                tone="danger"
                title="Доступ заблокирован"
                description={
                  view?.error?.message ??
                  'Сервер запретил доступ для этой учётной записи.'
                }
                actionLabel="Войти в другой аккаунт"
                onAction={() => {
                  setMode('login')
                  void run(() => window.crToolsAuth.resetLogin())
                }}
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
                <p>Проверяем сохранённый вход</p>
              </div>
            ) : (
              <CredentialsForm
                mode={mode}
                sessionReplaced={
                  view?.error?.code === 'UNAUTHORIZED' &&
                  view.error.message === 'Выполнен вход на другом устройстве'
                }
                pending={pending}
                error={view?.error?.message ?? null}
                onModeChange={setMode}
                onSubmit={submitCredentials}
              />
            )}
          </div>
          <AuthUpdatePanel
            view={updateView}
            unavailable={updateUnavailable}
            pending={updatePending}
            onRun={runUpdate}
          />
        </div>
      </section>
    </main>
  )
}

function AuthUpdatePanel({
  view,
  unavailable,
  pending,
  onRun,
}: {
  view: UpdateView | null
  unavailable: boolean
  pending: boolean
  onRun: (operation: () => Promise<UpdateView>, background: boolean) => Promise<void>
}): React.JSX.Element {
  let status = 'Получаем состояние обновлений...'
  let actionLabel = 'Проверить обновления'
  let operation = () => window.crToolsAuth.checkForUpdate()

  if (unavailable) {
    status = 'Не удалось получить состояние обновлений.'
  } else if (view !== null) {
    if (view.state === 'CHECKING') {
      status = 'Проверяем наличие новой версии...'
    } else if (view.state === 'AVAILABLE') {
      status = `${view.critical ? 'Важное обновление' : 'Доступно обновление'} ${view.availableVersion ?? ''}`
      actionLabel = 'Скачать обновление'
      operation = () => window.crToolsAuth.downloadUpdate()
    } else if (view.state === 'DOWNLOADING') {
      status = `Загрузка ${Math.round(view.progress?.percent ?? 0)}%`
      actionLabel = 'Отменить загрузку'
      operation = () => window.crToolsAuth.cancelUpdate()
    } else if (view.state === 'READY') {
      status =
        view.error === null
          ? `Версия ${view.availableVersion ?? ''} готова к установке`
          : `${publicErrorMessage(view.error.code, view.error.message)} (${view.error.code})`
      actionLabel = 'Установить обновление'
      operation = () => window.crToolsAuth.installUpdate()
    } else if (view.state === 'UP_TO_DATE') {
      status = `Установлена актуальная версия ${view.currentVersion}`
    } else if (view.state === 'FAILED') {
      status =
        view.error === null
          ? 'Проверка обновлений завершилась ошибкой.'
          : `${publicErrorMessage(view.error.code, view.error.message)} (${view.error.code})`
    } else {
      status = `Текущая версия ${view.currentVersion}`
    }
  }

  return (
    <aside className="auth-update" aria-label="Обновление приложения">
      <div aria-live="polite">
        <strong>Обновление приложения</strong>
        <span>{status}</span>
      </div>
      <button
        type="button"
        disabled={pending || view?.state === 'CHECKING'}
        onClick={() => void onRun(operation, view?.state === 'AVAILABLE')}
      >
        {pending ? 'Выполняем...' : actionLabel}
      </button>
    </aside>
  )
}

function CredentialsForm({
  mode,
  sessionReplaced,
  pending,
  error,
  onModeChange,
  onSubmit,
}: {
  mode: FormMode
  sessionReplaced: boolean
  pending: boolean
  error: string | null
  onModeChange: (mode: FormMode) => void
  onSubmit: (event: FormSubmitEvent) => void
}): React.JSX.Element {
  return (
    <form className="auth-form" onSubmit={onSubmit}>
      {sessionReplaced && (
        <div className="session-notice" role="alert" aria-live="assertive">
          <h3>Вы вышли из аккаунта</h3>
          <p>{error}</p>
        </div>
      )}
      <div className="form-icon">
        <UserRound aria-hidden="true" size={22} />
      </div>
      <span className="eyebrow">УЧЁТНАЯ ЗАПИСЬ</span>
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
      {mode === 'register' && (
        <>
          <label htmlFor="invite-key">Ключ доступа</label>
          <input
            id="invite-key"
            name="inviteKey"
            autoComplete="off"
            aria-describedby="invite-key-help"
            pattern={'\\s*[A-Za-z0-9_\\-]{8,50}\\s*'}
            title="Ключ: 8–50 латинских букв, цифр, символов _ или -"
            required
          />
          <p id="invite-key-help" className="form-description">
            Ключ покупается у администратора. Нужен один раз — потом входите по почте и
            паролю на любом устройстве
          </p>
        </>
      )}
      {!sessionReplaced && (
        <div className="form-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}
      <button className="primary-button" disabled={pending} type="submit">
        <LockKeyhole aria-hidden="true" size={16} />
        {pending ? 'Отправляем...' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
      </button>
      {mode === 'login' && (
        <p className="form-description">
          Уже зарегистрированы на телефоне или сайте? Входите той же почтой и паролем
        </p>
      )}
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
