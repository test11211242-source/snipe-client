import { useEffect, useRef, useState } from 'react'

import { Button, Icon, Spinner, cx } from '../../ui'
import styles from './Widgets.module.css'

const LOAD_TIMEOUT_MS = 15_000

type FrameStatus = 'loading' | 'ready' | 'error'

/**
 * The widget as OBS will render it (an iframe reports no load errors, so a frame that
 * has not loaded in time counts as failed), from the token-free preview URL, scaled to fit the
 * stage and centred. The frame has no access to the app: sandboxed scripts only.
 */
export function WidgetPreview({
  url,
  width,
  height,
  title,
  dimmed,
}: {
  url: string
  width: number
  height: number
  title: string
  /** The widget is switched off: shown greyed out, as OBS would show nothing. */
  dimmed: boolean
}): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  return (
    <Frame
      dimmed={dimmed}
      height={height}
      key={`${url}#${attempt}`}
      onRetry={() => setAttempt((current) => current + 1)}
      title={title}
      url={url}
      width={width}
    />
  )
}

function Frame({
  url,
  width,
  height,
  title,
  dimmed,
  onRetry,
}: {
  url: string
  width: number
  height: number
  title: string
  dimmed: boolean
  onRetry: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<FrameStatus>('loading')
  const [available, setAvailable] = useState<number | null>(null)
  const stage = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setTimeout(
      () => setStatus((current) => (current === 'loading' ? 'error' : current)),
      LOAD_TIMEOUT_MS,
    )
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const element = stage.current
    if (element === null) return
    const measure = (): void => setAvailable(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const scale = available === null || available === 0 ? 1 : Math.min(1, available / width)
  return (
    <div className={styles['stage']} ref={stage}>
      <iframe
        className={cx(styles['fit'], dimmed && styles['off'])}
        data-status={status}
        height={height}
        onLoad={() => setStatus((current) => (current === 'error' ? current : 'ready'))}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src={url}
        style={{
          width,
          height,
          transform: `translate(-50%, -50%) scale(${scale})`,
          visibility: status === 'ready' ? 'visible' : 'hidden',
        }}
        title={title}
        width={width}
      />
      {status === 'loading' ? (
        <div className={styles['state']} role="status">
          <Spinner />
          <span>Загружаем предпросмотр…</span>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className={styles['state']} role="alert">
          <Icon name="alert" size={20} />
          <b>Не удалось загрузить предпросмотр</b>
          <span>Сервер не ответил. Сами виджеты в OBS это не затрагивает.</span>
          <Button onClick={onRetry} size="sm">
            <Icon name="refresh" size={14} />
            Повторить
          </Button>
        </div>
      ) : null}
    </div>
  )
}
