import { Button, Icon, State } from '../../ui'
import { useRouter } from '../router'

/** Full-window route of profile setup (M4). Temporarily links to the old setup flow. */
export function SetupRoute(): React.JSX.Element {
  const { navigate, back } = useRouter()
  return (
    <State
      actions={
        <>
          <Button onClick={() => back()} variant="ghost">
            Назад
          </Button>
          <Button
            onClick={() => navigate({ name: 'legacy', page: 'setup' })}
            variant="primary"
          >
            <Icon name="external" size={15} />
            Настроить профиль (прежний мастер)
          </Button>
        </>
      }
      icon="wand"
      title="Настройка профиля"
    >
      Новый мастер настройки скоро заменит этот экран.
    </State>
  )
}
