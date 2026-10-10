import { useRouter } from '../../app/router'
import { useShellActions } from '../../app/shell/slotsContext'
import { Button, Icon, Skeleton, Spinner, State } from '../../ui'
import { cx } from '../../ui/cx'
import { Deck } from '../../ui'
import type { MonitorController } from '../monitor'
import { useAuth } from '../auth'
import styles from './Opponent.module.css'
import type { OpponentPresentation } from './types'

type Kind<K extends OpponentPresentation['kind']> = Extract<
  OpponentPresentation,
  { kind: K }
>

function Step({
  state,
  children,
}: {
  state: 'done' | 'pending' | 'blocked'
  children: string
}): React.JSX.Element {
  return (
    <li
      className={cx(
        styles['step'],
        state === 'done' && styles['stepDone'],
        state === 'blocked' && styles['stepBlocked'],
      )}
    >
      {state === 'pending' ? (
        <Spinner />
      ) : (
        <Icon name={state === 'done' ? 'checkCircle' : 'alert'} size={16} />
      )}
      <span>{children}</span>
    </li>
  )
}

/** First run: no profile yet. */
export function FirstRun(): React.JSX.Element {
  const { navigate } = useRouter()
  return (
    <State
      actions={
        <Button onClick={() => navigate({ name: 'setup' })} size="lg" variant="primary">
          <Icon name="plus" size={16} />
          Создать профиль
        </Button>
      }
      icon="wand"
      title="Давайте настроим CR Tools"
    >
      Выберите окно игры — и мониторинг сам найдёт соперника в бою.
    </State>
  )
}

/** PREFLIGHT/STARTING with the real readiness checks. */
export function Starting({
  readiness,
}: {
  readiness: Kind<'starting'>['readiness']
}): React.JSX.Element {
  return (
    <State icon="clock" title="Запускаем мониторинг…">
      <ul aria-label="Проверки запуска" className={styles['steps']}>
        <Step state={readiness.authenticated ? 'done' : 'blocked'}>Вход в аккаунт</Step>
        <Step state={readiness.captureConfigured ? 'done' : 'blocked'}>
          Профиль настроен
        </Step>
        <Step
          state={
            readiness.sourceAvailable === null
              ? 'pending'
              : readiness.sourceAvailable
                ? 'done'
                : 'blocked'
          }
        >
          Окно игры найдено
        </Step>
      </ul>
    </State>
  )
}

export function Stopping(): React.JSX.Element {
  return <State icon="clock" title="Останавливаем мониторинг…" />
}

/** WAITING_SOURCE: calm, amber, no red, no retry — recovery runs on its own. */
export function WaitingSource({
  monitor,
}: {
  monitor: MonitorController
}): React.JSX.Element {
  const { openProfiles } = useShellActions()
  return (
    <State
      actions={
        <>
          <Button loading={monitor.stopping} onClick={() => void monitor.stop()}>
            <Icon name="stop" size={13} />
            Остановить
          </Button>
          <Button onClick={openProfiles} variant="ghost">
            Окно изменилось? Выбрать другое
          </Button>
        </>
      }
      icon="window"
      pulse
      title="Ждём окно игры…"
      tone="warn"
    >
      Как только окно появится, мониторинг продолжится сам. Ничего нажимать не нужно.
    </State>
  )
}

/** SOURCE_REBIND_REQUIRED: the binding is not verifiable and waiting cannot fix it. */
export function RebindRequired({ message }: { message: string }): React.JSX.Element {
  const { openProfiles } = useShellActions()
  return (
    <State
      actions={
        <Button onClick={openProfiles} variant="primary">
          Открыть профили
        </Button>
      }
      icon="window"
      meta="SOURCE_REBIND_REQUIRED"
      title="Нужно выбрать окно игры заново"
      tone="warn"
    >
      {message}
    </State>
  )
}

export function Failed({
  error,
  monitor,
}: {
  error: Kind<'failed'>['error']
  monitor: MonitorController
}): React.JSX.Element {
  const { openProfiles } = useShellActions()
  return (
    <State
      actions={
        <>
          <Button
            loading={monitor.starting}
            onClick={() => void monitor.start()}
            variant="primary"
          >
            Повторить запуск
          </Button>
          <Button onClick={openProfiles} variant="ghost">
            Перенастроить профиль
          </Button>
        </>
      }
      icon="alert"
      meta={error?.code}
      title="Не удалось запустить"
      tone="danger"
    >
      {error?.message ?? 'Проверьте профиль и повторите запуск.'}
    </State>
  )
}

export function Stopped({ monitor }: { monitor: MonitorController }): React.JSX.Element {
  return (
    <State
      actions={
        <Button
          loading={monitor.starting}
          onClick={() => void monitor.start()}
          size="lg"
          variant="primary"
        >
          <Icon name="play" size={15} />
          Начать мониторинг
        </Button>
      }
      icon="target"
      title="Мониторинг остановлен"
    >
      Начните мониторинг перед боем — соперник появится здесь сам.
    </State>
  )
}

export function Idle(): React.JSX.Element {
  return (
    <State icon="target" pulse title="Ждём бой" tone="ok">
      Как только начнётся экран «VS», мы найдём соперника и покажем его колоды.
    </State>
  )
}

/** Authentication is required again: sign in through the auth window. */
export function AuthRequired(): React.JSX.Element {
  const auth = useAuth()
  return (
    <State
      actions={
        <Button onClick={() => void auth.logout()} variant="primary">
          Войти заново
        </Button>
      }
      icon="user"
      title="Нужно войти в аккаунт"
      tone="warn"
    >
      Сессия входа закончилась. Войдите снова — мониторинг продолжит работу.
    </State>
  )
}

/** Request sent, no answer yet: the nickname is visible only when it was really read. */
export function Searching({ nickname }: { nickname: string | null }): React.JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite" className={styles['searching']}>
      <div className={styles['idRow']}>
        <div className={styles['idMain']}>
          {nickname === null ? (
            <>
              <Skeleton height={32} width={200} />
              <span className={styles['caption']}>Читаем ник…</span>
            </>
          ) : (
            <>
              <h2 className={styles['name']}>{nickname}</h2>
              <span className={styles['caption']}>Ищем игрока в базе…</span>
            </>
          )}
        </div>
        <Skeleton height={32} width={110} />
      </div>
      <Deck cards={[]} label="Колода загружается" loading showNames={false} />
    </div>
  )
}
