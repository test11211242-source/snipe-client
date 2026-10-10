import { useCallback, useEffect, useState } from 'react'

import type { WindowAction } from '../../../../shared/contracts/window'
import { Icon, cx } from '../../ui'
import styles from './Titlebar.module.css'

/**
 * Frameless titlebar. Window commands go through crTools.window.command; "close" follows
 * the main-process tray policy (it may only hide the window).
 */
export function Titlebar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  const send = useCallback(async (action: WindowAction): Promise<void> => {
    try {
      const view = await window.crTools.window.command(action)
      setMaximized(view.maximized)
    } catch {
      // Window state is reconciled by the next query.
    }
  }, [])

  // Reconcile native maximize/restore (snap, double-click on the drag area, OS shortcuts).
  useEffect(() => {
    let timer: number | undefined
    let active = true
    const query = (): void => {
      window.crTools.window.command('get').then(
        (view) => {
          if (active) setMaximized(view.maximized)
        },
        () => undefined,
      )
    }
    query()
    const onResize = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(query, 150)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(timer)
      active = false
    }
  }, [])

  return (
    <header className={styles['bar']}>
      <span aria-hidden="true" className={styles['logo']} />
      <span className={styles['title']}>CR Tools</span>
      <div className={styles['controls']}>
        <button
          aria-label="Свернуть окно"
          className={styles['control']}
          onClick={() => void send('minimize')}
          type="button"
        >
          <Icon name="minimize" size={14} />
        </button>
        <button
          aria-label={maximized ? 'Восстановить окно' : 'Развернуть окно'}
          className={styles['control']}
          onClick={() => void send(maximized ? 'restore' : 'maximize')}
          type="button"
        >
          <Icon name={maximized ? 'copy' : 'maximize'} size={12} />
        </button>
        <button
          aria-label="Закрыть окно"
          className={cx(styles['control'], styles['close'])}
          onClick={() => void send('close')}
          type="button"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </header>
  )
}
