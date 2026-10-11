import type { ReactNode } from 'react'

import { Button, Icon, Menu, MenuItem, type IconName, cx } from '../../ui'
import { useTier } from '../useTier'
import styles from './SplitLayout.module.css'

export interface NavItem {
  id: string
  title: string
  /** One status line, e.g. "включено". */
  sub?: string | undefined
  warn?: boolean
  icon: IconName
  current: boolean
  /** Arrow instead of selection: the item leaves this area ("в настройках"). */
  external?: boolean
  onSelect: () => void
}

export interface NavGroup {
  title?: string
  items: readonly NavItem[]
}

/**
 * Left navigation + section head + scrolling content (streamer area and settings).
 * At mini width the navigation becomes a menu in the section head, so every destination
 * stays reachable by keyboard.
 */
export function SplitLayout({
  navLabel,
  groups,
  title,
  headTrail,
  children,
}: {
  navLabel: string
  groups: readonly NavGroup[]
  title: string
  headTrail?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const tier = useTier()
  const mini = tier === 'mini'
  const all = groups.flatMap((group) => group.items)
  const current = all.find((item) => item.current)

  return (
    <div
      className={cx(
        styles['split'],
        mini && styles['mini'],
        tier === 'medium' && styles['medium'],
      )}
    >
      {mini ? null : (
        <nav aria-label={navLabel} className={styles['nav']}>
          {groups.map((group, index) => (
            <div key={group.title ?? index}>
              {group.title === undefined ? null : (
                <p className={styles['group']}>{group.title}</p>
              )}
              {group.items.map((item) => (
                <button
                  aria-current={item.current ? 'page' : undefined}
                  className={styles['item']}
                  key={item.id}
                  onClick={item.onSelect}
                  type="button"
                >
                  <Icon name={item.icon} size={18} />
                  <span className={styles['itemText']}>
                    <span className={styles['itemTitle']}>{item.title}</span>
                    {item.sub === undefined ? null : (
                      <span
                        className={cx(
                          styles['itemSub'],
                          item.warn === true && styles['warn'],
                        )}
                      >
                        {item.sub}
                      </span>
                    )}
                  </span>
                  {item.external === true ? (
                    <Icon className={styles['arrow']} name="chevronRight" size={14} />
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
      )}
      <div className={styles['body']}>
        <div className={styles['head']}>
          {mini ? (
            <Menu
              label={navLabel}
              trigger={({ props }) => (
                <Button
                  {...props}
                  aria-label={`${navLabel}: ${current?.title ?? title}`}
                  variant="ghost"
                >
                  <Icon name={current?.icon ?? 'grid'} size={16} />
                  <span className={styles['title']}>{title}</span>
                  <Icon name="chevronDown" size={14} />
                </Button>
              )}
              width={300}
            >
              {all.map((item) => (
                <MenuItem
                  aria-current={item.current ? 'page' : undefined}
                  key={item.id}
                  onSelect={item.onSelect}
                >
                  <Icon name={item.icon} size={16} />
                  <span>{item.title}</span>
                </MenuItem>
              ))}
            </Menu>
          ) : (
            <h1 className={styles['title']}>{title}</h1>
          )}
          {headTrail}
        </div>
        <div className={styles['scroll']}>{children}</div>
      </div>
    </div>
  )
}
