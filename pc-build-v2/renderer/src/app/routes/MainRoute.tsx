import { useMonitorView, selectRunPhase } from '../../features/monitor'
import { useProfiles } from '../../features/profiles'
import { Button, Icon, State } from '../../ui'
import { useRouter } from '../router'

/**
 * M3 builds the opponent card, session stats, history and summary here. Until then the
 * page shows the real monitor state with the same calm presentation and a temporary link
 * to the old main screen.
 */
export function MainRoute(): React.JSX.Element {
  const monitor = useMonitorView()
  const profiles = useProfiles()
  const { navigate } = useRouter()
  const hasProfiles = (profiles.value?.profiles.length ?? 0) > 0
  const phase = selectRunPhase(monitor.value, hasProfiles)
  const legacy = (
    <Button onClick={() => navigate({ name: 'legacy', page: 'home' })} variant="ghost">
      <Icon name="external" size={15} />
      Прежний главный экран
    </Button>
  )

  if (profiles.value === null && profiles.error === null)
    return <State icon="clock" title="Загружаем данные…" />

  switch (phase) {
    case 'no-profile':
      return (
        <State
          actions={
            <Button
              onClick={() => navigate({ name: 'setup' })}
              size="lg"
              variant="primary"
            >
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
    case 'starting':
      return <State icon="clock" title="Запускаем мониторинг…" />
    case 'stopping':
      return <State icon="clock" title="Останавливаем мониторинг…" />
    case 'waiting-source':
      return (
        <State actions={legacy} icon="window" pulse title="Ждём окно игры" tone="warn">
          Как только окно появится, мониторинг продолжится сам. Ничего нажимать не нужно.
        </State>
      )
    case 'running':
      return (
        <State actions={legacy} icon="target" pulse title="Ждём бой" tone="ok">
          Как только начнётся экран «VS», мы найдём соперника и покажем его колоды.
        </State>
      )
    case 'failed':
      return (
        <State
          actions={
            <>
              <Button onClick={() => void monitor.start()} variant="primary">
                Повторить запуск
              </Button>
              {legacy}
            </>
          }
          icon="alert"
          title="Не удалось запустить"
          tone="danger"
        >
          {monitor.value?.error?.message ?? 'Проверьте профиль и повторите запуск.'}
        </State>
      )
    case 'stopped':
      return (
        <State
          actions={
            <>
              <Button
                loading={monitor.starting}
                onClick={() => void monitor.start()}
                size="lg"
                variant="primary"
              >
                <Icon name="play" size={15} />
                Начать мониторинг
              </Button>
              {legacy}
            </>
          }
          icon="target"
          title="Мониторинг остановлен"
        >
          Начните мониторинг перед боем — соперник появится здесь сам.
        </State>
      )
  }
}
