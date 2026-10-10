import { Button, Icon, State, type IconName } from '../../ui'
import { useRouter, type LegacyPage } from '../router'

/**
 * Empty route page for a milestone that has not built it yet, with the temporary link to
 * the old screen. Replace the whole component in the owning milestone.
 */
export function Placeholder({
  icon,
  title,
  text,
  legacy,
  legacyLabel = 'Открыть прежний экран',
}: {
  icon: IconName
  title: string
  text: string
  legacy?: LegacyPage
  legacyLabel?: string
}): React.JSX.Element {
  const { navigate } = useRouter()
  return (
    <State
      actions={
        legacy === undefined ? undefined : (
          <Button onClick={() => navigate({ name: 'legacy', page: legacy })}>
            <Icon name="external" size={15} />
            {legacyLabel}
          </Button>
        )
      }
      icon={icon}
      title={title}
    >
      {text}
    </State>
  )
}
