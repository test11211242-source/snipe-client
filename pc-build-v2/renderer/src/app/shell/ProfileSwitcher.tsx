import { useMonitorView } from '../../features/monitor'
import { profileHealth, useProfiles } from '../../features/profiles'
import { Button, Icon, Menu, MenuItem, MenuSeparator, Skeleton, cx } from '../../ui'
import { useRouter } from '../router'
import styles from './CommandBar.module.css'

const MAX_PROFILES = 20

/** Profile switcher of the command bar, wired to the real profile view. */
export function ProfileSwitcher({
  onManage,
  flex,
}: {
  onManage: () => void
  flex: boolean
}): React.JSX.Element {
  const { value, error, loading, reload, activate, pending } = useProfiles()
  const monitor = useMonitorView()
  const { navigate } = useRouter()
  const wrapClass = `${styles['switcherWrap']} ${flex ? styles['switcherFlex'] : ''}`

  if (value === null) {
    if (error !== null)
      return (
        <div className={wrapClass}>
          <Button onClick={() => void reload()} size="lg" variant="danger">
            <Icon name="refresh" size={15} />
            Профили недоступны. Повторить
          </Button>
        </div>
      )
    return (
      <div className={wrapClass}>
        <Skeleton height="var(--control-lg)" width={240} />
        {loading ? <span className="sr-only">Загружаем профили</span> : null}
      </div>
    )
  }

  if (value.profiles.length === 0)
    return (
      <div className={wrapClass}>
        <button
          aria-label="Создать профиль"
          className={styles['switcher']}
          onClick={() => navigate({ name: 'setup' })}
          type="button"
        >
          <span className={styles['icon']}>
            <Icon name="plus" size={16} />
          </span>
          <span className={styles['text']}>
            <span className={styles['name']}>Нет профиля</span>
            <span className={styles['sub']}>Создайте первый профиль</span>
          </span>
        </button>
      </div>
    )

  const waiting = monitor.value?.state === 'WAITING_SOURCE'
  const active = value.profiles.find((profile) => profile.isActive) ?? value.profiles[0]
  if (active === undefined) return <div className={wrapClass} />
  const activeHealth = profileHealth(active, waiting)

  return (
    <Menu
      className={wrapClass}
      label="Профили"
      trigger={({ props }) => (
        <button
          {...props}
          aria-label={`Профиль: ${active.profileName}`}
          className={styles['switcher']}
          type="button"
        >
          <span className={styles['icon']}>
            <Icon
              name={active.sourceKind === 'display' ? 'monitor' : 'window'}
              size={16}
            />
            <i
              className={cx(styles['health'], activeHealth.warn && styles['healthWarn'])}
            />
          </span>
          <span className={styles['text']}>
            <span className={styles['name']}>{active.profileName}</span>
            <span className={cx(styles['sub'], activeHealth.warn && styles['subWarn'])}>
              {active.sourceLabel}
              {activeHealth.warn ? ` · ${activeHealth.text}` : ''}
            </span>
          </span>
          <Icon className={styles['chev']} name="chevronDown" size={16} />
        </button>
      )}
      width={360}
    >
      {value.profiles.map((profile) => {
        const health = profileHealth(profile, waiting)
        return (
          <MenuItem
            aria-checked={profile.isActive}
            disabled={pending}
            key={profile.profileId}
            onSelect={() => {
              if (!profile.isActive) void activate(profile.profileId)
            }}
          >
            <span className={styles['itemLead']}>
              <Icon
                name={profile.sourceKind === 'display' ? 'monitor' : 'window'}
                size={15}
              />
              <i className={cx(styles['health'], health.warn && styles['healthWarn'])} />
            </span>
            <span className={styles['itemMain']}>
              <span className={styles['itemTitle']}>{profile.profileName}</span>
              <span className={styles['itemSub']}>{profile.sourceLabel}</span>
            </span>
            <span className={cx(styles['itemHealth'], health.warn && styles['itemWarn'])}>
              {health.text}
            </span>
            <span className={styles['itemCheck']}>
              {profile.isActive ? <Icon name="check" size={16} /> : null}
            </span>
          </MenuItem>
        )
      })}
      <MenuSeparator />
      <MenuItem onSelect={() => navigate({ name: 'setup' })}>
        <span className={cx(styles['itemLead'], styles['itemLeadPlain'])}>
          <Icon name="wand" size={16} />
        </span>
        <span className={styles['itemMain']}>
          <span className={styles['itemTitle']}>Новый профиль</span>
          <span className={styles['itemSub']}>Настройка за минуту</span>
        </span>
      </MenuItem>
      <MenuItem onSelect={onManage}>
        <span className={cx(styles['itemLead'], styles['itemLeadPlain'])}>
          <Icon name="sliders" size={16} />
        </span>
        <span className={styles['itemMain']}>
          <span className={styles['itemTitle']}>Управлять профилями</span>
          <span className={styles['itemSub']}>
            {value.profiles.length} из {MAX_PROFILES}
          </span>
        </span>
      </MenuItem>
    </Menu>
  )
}
