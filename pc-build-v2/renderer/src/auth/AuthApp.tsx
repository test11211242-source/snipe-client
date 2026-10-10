import { useEffect, useState, type SyntheticEvent } from 'react'

import type { AuthView } from '../../../shared/models/auth'
import type { ApiErrorCode } from '../../../shared/errors/api-error'
import {
  Banner,
  Button,
  DialogNotes,
  Field,
  Icon,
  IconButton,
  Input,
  Progress,
  Segment,
  Spinner,
  State,
} from '../ui'
import styles from './Auth.module.css'
import { useAuthUpdater, type AuthUpdater } from './useAuthUpdater'

type FormMode = 'login' | 'register'
interface Drafts {
  email: string
  username: string
  inviteKey: string
  password: string
}
type FieldErrors = Partial<Record<keyof Drafts, string>>

const SESSION_REPLACED = 'Выполнен вход на другом устройстве'
const NETWORKISH: readonly ApiErrorCode[] = ['NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT']

/** What to do next, by error code; the headline is the server's own specific message. */
const HINTS: Partial<Record<ApiErrorCode, string>> = {
  UNAUTHORIZED: 'Проверьте раскладку и Caps Lock. Забыли пароль — напишите в поддержку.',
  NETWORK_UNAVAILABLE:
    'Проверьте интернет и нажмите «Повторить». Введённые данные сохранены.',
  REQUEST_TIMEOUT: 'Подождите минуту и повторите попытку.',
  FORBIDDEN: 'Напишите в поддержку — подскажем, что делать дальше.',
  VALIDATION_FAILED:
    'Проверьте введённые данные. Ключ приглашения мог быть уже использован или набран с ошибкой.',
  SERVER_ERROR: 'Это не ваша вина. Повторите через пару минут.',
  DEVICE_IDENTITY_UNAVAILABLE:
    'Перезапустите приложение. Если повторится — напишите в поддержку.',
  SECRET_UNAVAILABLE: 'Войдите заново: сохранённый вход прочитать не удалось.',
  SECRET_INVALID: 'Войдите заново: сохранённый вход прочитать не удалось.',
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE = /^[A-Za-z0-9_-]{8,50}$/

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

function validate(mode: FormMode, drafts: Drafts): FieldErrors {
  const errors: FieldErrors = {}
  if (!EMAIL.test(drafts.email.trim()) || drafts.email.length > 254)
    errors.email = 'Нужна запись вида name@mail.ru'
  if (mode === 'register') {
    const name = drafts.username.trim()
    if (name.length < 2 || name.length > 50) errors.username = 'Имя — от 2 до 50 символов'
    if (!INVITE.test(drafts.inviteKey.trim()))
      errors.inviteKey = 'Ключ — от 8 до 50 символов: латинские буквы, цифры, «-» и «_»'
    if (drafts.password.length < 8) errors.password = 'Пароль не короче 8 символов'
  } else if (drafts.password.length === 0) {
    errors.password = 'Введите пароль'
  }
  return errors
}

/** Narrow main-owned bootstrap view: login, register and the blocked/error/update states. */
export function AuthApp(): React.JSX.Element {
  const [view, setView] = useState<AuthView | null>(null)
  const [mode, setMode] = useState<FormMode>('login')
  const [pending, setPending] = useState(false)
  const updater = useAuthUpdater()

  useEffect(() => {
    let active = true
    let timer: number | undefined
    const refresh = (): void => {
      window.crToolsAuth.getView().then(
        (next) => {
          if (!active) return
          setView(next)
          if (next.state === 'BOOTSTRAPPING') timer = window.setTimeout(refresh, 250)
        },
        () => {
          if (active) setView(ipcErrorView())
        },
      )
    }
    refresh()
    return () => {
      active = false
      window.clearTimeout(timer)
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

  const update = updater.view
  const updateRequired =
    update?.critical === true &&
    update.availableVersion !== null &&
    update.state !== 'IDLE' &&
    update.state !== 'UP_TO_DATE' &&
    update.state !== 'CHECKING'
  const state = view?.state ?? 'BOOTSTRAPPING'
  // While a submit runs the form stays (button spinner), so typed values are never lost.
  const loading = state === 'BOOTSTRAPPING' || state === 'AUTHENTICATED'
  const network =
    view?.error !== null &&
    view?.error !== undefined &&
    NETWORKISH.includes(view.error.code)

  let body: React.JSX.Element
  if (updateRequired) {
    body = <UpdateRequired updater={updater} />
  } else if (state === 'BLOCKED') {
    body = (
      <State
        actions={
          <Button
            onClick={() => {
              setMode('login')
              void run(() => window.crToolsAuth.resetLogin())
            }}
            variant="primary"
          >
            Войти в другой аккаунт
          </Button>
        }
        icon="lock"
        title="Доступ заблокирован"
        tone="danger"
      >
        {view?.error?.message ?? 'Сервер запретил доступ для этой учётной записи.'}
      </State>
    )
  } else if (state === 'ERROR') {
    const retryable = view?.error?.retryable === true
    body = (
      <State
        actions={
          <>
            {retryable ? (
              <Button
                onClick={() => void run(() => window.crToolsAuth.retryBootstrap())}
                variant="primary"
              >
                <Icon name="refresh" size={15} />
                Повторить
              </Button>
            ) : null}
            <Button onClick={() => void run(() => window.crToolsAuth.resetLogin())}>
              Войти заново
            </Button>
          </>
        }
        icon={network ? 'wifiOff' : 'alert'}
        title="Не удалось проверить вход"
        tone={network ? 'warn' : 'danger'}
      >
        {view?.error?.message ?? 'Произошла ошибка авторизации.'}
      </State>
    )
  } else if (loading) {
    body = (
      <div className={styles['loading']} role="status">
        <Spinner />
        <h1>Проверяем вход</h1>
        <p>Это займёт секунду. Сохранённый вход проверяется на сервере.</p>
      </div>
    )
  } else {
    body = (
      <CredentialsForm
        error={view?.error ?? null}
        mode={mode}
        onModeChange={setMode}
        onSubmit={(drafts) =>
          void run(() =>
            mode === 'register'
              ? window.crToolsAuth.register({
                  email: drafts.email.trim(),
                  username: drafts.username.trim(),
                  password: drafts.password,
                  inviteKey: drafts.inviteKey,
                })
              : window.crToolsAuth.login({
                  email: drafts.email.trim(),
                  password: drafts.password,
                }),
          )
        }
        pending={pending}
        updater={updater}
      />
    )
  }

  return (
    <main className={styles['auth']}>
      <div className={styles['brand']}>
        <span aria-hidden="true" className={styles['logo']} />
        <b>CR Tools</b>
      </div>
      <div className={styles['body']}>{body}</div>
      <footer className={styles['foot']}>
        <span>{update === null ? '' : `Версия ${update.currentVersion}`}</span>
        {network ? <span className={styles['offline']}>Нет связи</span> : null}
      </footer>
    </main>
  )
}

function UpdateRequired({ updater }: { updater: AuthUpdater }): React.JSX.Element {
  const { view, pending } = updater
  if (view === null) return <></>
  const percent = Math.round(view.progress?.percent ?? 0)
  return (
    <section aria-labelledby="update-title" className={styles['update']}>
      <span className={styles['updateIcon']}>
        <Icon name="arrowUp" size={22} />
      </span>
      <h1 id="update-title">Нужно обновить CR Tools</h1>
      <p>
        Вышла обязательная версия {view.availableVersion}, у вас {view.currentVersion}.
        Чтобы продолжить, установите её — это займёт около минуты.
      </p>
      {view.releaseNotes.length > 0 ? <DialogNotes items={view.releaseNotes} /> : null}
      {view.state === 'DOWNLOADING' ? (
        <div>
          <Progress label="Загрузка обновления" value={percent} />
          <div className={styles['progressMeta']}>
            <span>
              {view.progress === null
                ? 'Начинаем загрузку…'
                : `Скачано ${Math.round(view.progress.downloadedBytes / 1048576)} МБ из ${Math.round(view.progress.totalBytes / 1048576)} МБ`}
            </span>
            <span>{percent}%</span>
          </div>
        </div>
      ) : null}
      {view.error === null ? null : (
        <Banner icon="alert" title="Обновление не удалось" tone="danger">
          {view.error.message}
          {view.error.retryable ? ' Попробуйте ещё раз.' : ''}
        </Banner>
      )}
      {updater.unavailable ? (
        <Banner icon="wifiOff" title="Нет ответа от обновления" tone="warn">
          Не удалось получить состояние обновления. Повторите через минуту.
        </Banner>
      ) : null}
      {view.state === 'DOWNLOADING' ? (
        <>
          <Button disabled size="lg" variant="primary">
            Скачиваем…
          </Button>
          <Button
            disabled={pending === 'cancel'}
            onClick={() => void updater.run('cancel')}
            variant="ghost"
          >
            Отменить загрузку
          </Button>
        </>
      ) : view.state === 'READY' ? (
        <Button
          loading={pending === 'install'}
          onClick={() => void updater.run('install')}
          size="lg"
          variant="primary"
        >
          <Icon name="refresh" size={15} />
          Перезапустить для установки
        </Button>
      ) : (
        <Button
          loading={pending === 'download'}
          onClick={() => void updater.run('download')}
          size="lg"
          variant="primary"
        >
          <Icon name="download" size={15} />
          {view.state === 'FAILED' ? 'Повторить загрузку' : 'Скачать и обновить'}
        </Button>
      )}
    </section>
  )
}

function UpdateStrip({ updater }: { updater: AuthUpdater }): React.JSX.Element | null {
  const { view, pending } = updater
  if (view?.availableVersion === undefined || view.availableVersion === null) return null
  if (view.state === 'AVAILABLE')
    return (
      <Banner
        actions={
          <Button
            loading={pending === 'download'}
            onClick={() => void updater.run('download')}
            size="sm"
          >
            Скачать
          </Button>
        }
        icon="arrowUp"
        title={`Доступна версия ${view.availableVersion}`}
      >
        Обновление займёт около минуты.
      </Banner>
    )
  if (view.state === 'DOWNLOADING')
    return (
      <Banner
        actions={
          <Button
            disabled={pending === 'cancel'}
            onClick={() => void updater.run('cancel')}
            size="sm"
          >
            Отменить
          </Button>
        }
        icon="download"
        title={`Скачиваем версию ${view.availableVersion}`}
      >
        {Math.round(view.progress?.percent ?? 0)}%
      </Banner>
    )
  if (view.state === 'READY')
    return (
      <Banner
        actions={
          <Button
            loading={pending === 'install'}
            onClick={() => void updater.run('install')}
            size="sm"
            variant="primary"
          >
            Установить
          </Button>
        }
        icon="checkCircle"
        title={`Версия ${view.availableVersion} скачана`}
        tone="ok"
      >
        Перезапустим приложение, чтобы установить.
      </Banner>
    )
  if (view.state === 'FAILED')
    return (
      <Banner
        actions={
          <Button
            loading={pending === 'download'}
            onClick={() => void updater.run('download')}
            size="sm"
          >
            Повторить
          </Button>
        }
        icon="wifiOff"
        title={`Не удалось скачать версию ${view.availableVersion}`}
        tone="warn"
      >
        {view.error?.message ?? 'Прежняя версия продолжает работать.'}
      </Banner>
    )
  return null
}

function CredentialsForm({
  mode,
  error,
  pending,
  updater,
  onModeChange,
  onSubmit,
}: {
  mode: FormMode
  error: AuthView['error']
  pending: boolean
  updater: AuthUpdater
  onModeChange: (mode: FormMode) => void
  onSubmit: (drafts: Drafts) => void
}): React.JSX.Element {
  // Drafts survive every failure: the form is only cleared by the user.
  const [drafts, setDrafts] = useState<Drafts>({
    email: '',
    username: '',
    inviteKey: '',
    password: '',
  })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [showPassword, setShowPassword] = useState(false)
  const register = mode === 'register'
  const replaced = error?.code === 'UNAUTHORIZED' && error.message === SESSION_REPLACED
  const change = (key: keyof Drafts, value: string): void => {
    setDrafts((current) => ({ ...current, [key]: value }))
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)),
    )
  }
  const attempt = (): void => {
    const problems = validate(mode, drafts)
    setErrors(problems)
    if (Object.keys(problems).length > 0) return
    onSubmit(drafts)
  }
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault()
    attempt()
  }
  const retryable = error !== null && NETWORKISH.includes(error.code)

  return (
    <form className={styles['form']} noValidate onSubmit={submit}>
      <UpdateStrip updater={updater} />
      <Segment
        full
        label="Режим авторизации"
        onChange={onModeChange}
        options={[
          { value: 'login', label: 'Вход' },
          { value: 'register', label: 'Регистрация' },
        ]}
        value={mode}
      />
      <div>
        <h1 className={styles['title']}>
          {register ? 'Создание аккаунта' : 'С возвращением'}
        </h1>
        <p className={styles['lead']}>
          {register
            ? 'Регистрация идёт по ключу приглашения.'
            : 'Войдите, чтобы продолжить мониторинг. Уже есть аккаунт на телефоне или сайте — входите той же почтой и паролем.'}
        </p>
      </div>
      {error === null ? null : replaced ? (
        <Banner icon="info" title="Вы вышли из аккаунта" tone="warn">
          {error.message}
        </Banner>
      ) : (
        <Banner
          actions={
            retryable ? (
              <Button disabled={pending} onClick={attempt} size="sm">
                <Icon name="refresh" size={14} />
                Повторить
              </Button>
            ) : undefined
          }
          icon={retryable ? 'wifiOff' : 'alert'}
          title={error.message}
          tone={retryable ? 'warn' : 'danger'}
        >
          {HINTS[error.code]}
        </Banner>
      )}
      <Field error={errors.email} label="Почта">
        {(controlProps) => (
          <Input
            {...controlProps}
            autoComplete="email"
            autoFocus
            maxLength={254}
            name="email"
            onChange={(event) => change('email', event.currentTarget.value)}
            size="lg"
            type="email"
            value={drafts.email}
          />
        )}
      </Field>
      {register ? (
        <Field
          error={errors.username}
          hint="Его увидите только вы и поддержка"
          label="Имя пользователя"
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              autoComplete="username"
              maxLength={50}
              name="username"
              onChange={(event) => change('username', event.currentTarget.value)}
              size="lg"
              value={drafts.username}
            />
          )}
        </Field>
      ) : null}
      {register ? (
        <Field
          error={errors.inviteKey}
          hint="Ключ выдаёт администратор. Нужен один раз — потом входите по почте и паролю."
          label="Ключ приглашения"
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              autoComplete="off"
              mono
              name="inviteKey"
              onChange={(event) => change('inviteKey', event.currentTarget.value)}
              size="lg"
              value={drafts.inviteKey}
            />
          )}
        </Field>
      ) : null}
      <Field
        error={errors.password}
        hint={register ? 'Не короче 8 символов' : undefined}
        label="Пароль"
      >
        {(controlProps) => (
          <div className={styles['password']}>
            <Input
              {...controlProps}
              autoComplete={register ? 'new-password' : 'current-password'}
              maxLength={256}
              name="password"
              onChange={(event) => change('password', event.currentTarget.value)}
              size="lg"
              type={showPassword ? 'text' : 'password'}
              value={drafts.password}
            />
            <IconButton
              label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              onClick={() => setShowPassword((shown) => !shown)}
              size="sm"
            >
              <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
            </IconButton>
          </div>
        )}
      </Field>
      <Button loading={pending} size="lg" type="submit" variant="primary">
        {register ? 'Создать аккаунт' : 'Войти'}
      </Button>
    </form>
  )
}
