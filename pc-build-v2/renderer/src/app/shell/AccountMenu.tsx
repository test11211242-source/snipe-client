import { useState } from 'react'

import type { UserRole } from '../../../../shared/models/auth'
import { useAuth, useRole } from '../../features/auth'
import {
  Avatar,
  ConfirmDialog,
  Icon,
  Menu,
  MenuHeader,
  MenuItem,
  MenuSeparator,
  Pill,
  cx,
} from '../../ui'
import { useRouter } from '../router'
import styles from './CommandBar.module.css'

const ROLE_LABELS: Record<UserRole, string> = {
  user: 'Игрок',
  premium: 'Премиум',
  admin: 'Администратор',
  streamer: 'Стример',
}

/**
 * Avatar menu: account, Clash Royale accounts, settings, logout (confirmed, real action).
 * At mini width the Игра/Стрим switch lives here too.
 */
export function AccountMenu({
  direction = 'down',
  showModes = false,
}: {
  direction?: 'down' | 'up'
  /** Include Игра / Стрим entries (mini width, where the segment is hidden). */
  showModes?: boolean
}): React.JSX.Element | null {
  const auth = useAuth()
  const role = useRole()
  const { navigate, route } = useRouter()
  const [confirming, setConfirming] = useState(false)
  const user = auth.value?.user ?? null
  if (user === null) return null

  return (
    <>
      <Menu
        align={direction === 'up' ? 'start' : 'end'}
        direction={direction}
        label="Аккаунт"
        trigger={({ props }) => (
          <button
            {...props}
            aria-label={`Аккаунт ${user.username}`}
            className={styles['avatarButton']}
            type="button"
          >
            <Avatar name={user.username} />
          </button>
        )}
        width={290}
      >
        <MenuHeader>
          <div className={styles['accountHead']}>
            <Avatar name={user.username} size="lg" />
            <div className={styles['itemMain']}>
              <span className={styles['itemTitle']}>{user.username}</span>
              <span className={styles['itemSub']}>{user.email}</span>
              <div className={styles['roles']}>
                {user.roles.map((item) => (
                  <Pill key={item} tone={item === 'streamer' ? 'ok' : 'neutral'}>
                    {ROLE_LABELS[item]}
                  </Pill>
                ))}
              </div>
            </div>
          </div>
        </MenuHeader>
        <MenuSeparator />
        {showModes ? (
          <>
            <MenuItem
              aria-current={route.name !== 'stream' ? 'page' : undefined}
              onSelect={() => navigate({ name: 'main' })}
            >
              <span className={cx(styles['itemLead'], styles['itemLeadPlain'])}>
                <Icon name="target" size={16} />
              </span>
              <span className={styles['itemTitle']}>Игра</span>
            </MenuItem>
            {role.isStreamer ? (
              <MenuItem
                aria-current={route.name === 'stream' ? 'page' : undefined}
                onSelect={() => navigate({ name: 'stream', section: 'overview' })}
              >
                <span className={cx(styles['itemLead'], styles['itemLeadPlain'])}>
                  <Icon name="broadcast" size={16} />
                </span>
                <span className={styles['itemTitle']}>Стрим</span>
              </MenuItem>
            ) : null}
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem onSelect={() => navigate({ name: 'settings', section: 'accounts' })}>
          <span className={cx(styles['itemLead'], styles['itemLeadPlain'])}>
            <Icon name="users" size={16} />
          </span>
          <span className={styles['itemTitle']}>Аккаунты Clash Royale</span>
        </MenuItem>
        <MenuItem onSelect={() => navigate({ name: 'settings', section: 'app' })}>
          <span className={cx(styles['itemLead'], styles['itemLeadPlain'])}>
            <Icon name="gear" size={16} />
          </span>
          <span className={styles['itemTitle']}>Настройки</span>
        </MenuItem>
        <MenuItem danger onSelect={() => setConfirming(true)}>
          <span className={cx(styles['itemLead'], styles['itemLeadPlain'])}>
            <Icon name="logout" size={16} />
          </span>
          <span className={styles['itemTitle']}>Выйти из аккаунта</span>
        </MenuItem>
      </Menu>
      {confirming ? (
        <ConfirmDialog
          confirmLabel="Выйти"
          error={auth.actionError}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            void auth.logout().then((done) => {
              if (done) setConfirming(false)
            })
          }}
          pending={auth.loggingOut}
          text="Мониторинг остановится, окно оверлея закроется. Профили и настройки сохранятся на этом компьютере."
          title="Выйти из аккаунта?"
        />
      ) : null}
    </>
  )
}
