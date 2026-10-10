import { Button, Icon, Panel, Pill, Row, State } from '../../ui'
import { useMonitorView } from '../monitor'
import { profileHealth } from './health'
import { useProfiles } from './index'

/**
 * Profiles side panel. M2 lists real profiles and activates them; rename / duplicate /
 * delete / rebind / result zones land in M4 (same controller, same panel).
 */
export function ProfilesPanel({
  onClose,
  onCreate,
  onLegacy,
}: {
  onClose: () => void
  onCreate: () => void
  /** Temporary link to the pre-V2 profile management screen. */
  onLegacy: () => void
}): React.JSX.Element {
  const { value, error, activate, pending, actionError, reload } = useProfiles()
  const monitor = useMonitorView()
  const waiting = monitor.value?.state === 'WAITING_SOURCE'
  const count = value?.profiles.length ?? 0

  return (
    <Panel
      footer={
        <>
          <span>{count} из 20</span>
          <Button onClick={onLegacy} size="sm" variant="ghost">
            Прежнее управление
          </Button>
        </>
      }
      onClose={onClose}
      title="Профили"
    >
      {value === null ? (
        <State
          actions={
            error === null ? undefined : (
              <Button onClick={() => void reload()}>
                <Icon name="refresh" size={15} />
                Повторить
              </Button>
            )
          }
          icon={error === null ? 'clock' : 'alert'}
          title={error === null ? 'Загружаем профили' : 'Профили недоступны'}
          tone={error === null ? 'neutral' : 'danger'}
        >
          {error?.message}
        </State>
      ) : count === 0 ? (
        <State
          actions={
            <Button onClick={onCreate} variant="primary">
              <Icon name="plus" size={15} />
              Создать профиль
            </Button>
          }
          icon="wand"
          title="Профилей пока нет"
        >
          Профиль — это окно или экран игры и положение триггера.
        </State>
      ) : (
        <div role="list">
          {value.profiles.map((profile) => {
            const health = profileHealth(profile, waiting)
            return (
              <div key={profile.profileId} role="listitem">
                <Row
                  bordered
                  lead={
                    <Icon
                      name={profile.sourceKind === 'display' ? 'monitor' : 'window'}
                      size={16}
                    />
                  }
                  sub={`${profile.sourceLabel}${health.text === '' ? '' : ` · ${health.text}`}`}
                  title={profile.profileName}
                  trail={
                    profile.isActive ? (
                      <Pill tone="ok">Активный</Pill>
                    ) : (
                      <Button
                        disabled={pending}
                        onClick={() => void activate(profile.profileId)}
                        size="sm"
                      >
                        Сделать активным
                      </Button>
                    )
                  }
                  warnSub={health.warn}
                />
              </div>
            )
          })}
        </div>
      )}
      {actionError === null ? null : <p role="alert">{actionError}</p>}
    </Panel>
  )
}
