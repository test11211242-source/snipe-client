import type { UpdateView } from '../../../shared/models/update'
import { Button } from './Button'
import { cx } from './cx'
import { Progress } from './Feedback'
import { Icon, type IconName } from './Icon'
import styles from './UpdateBar.module.css'

export interface UpdateBarProps {
  view: UpdateView
  /** Mini width: shorter copy and buttons. */
  compact?: boolean
  /** An update command is in flight. */
  busy?: boolean
  onDownload: () => void
  onInstall: () => void
  onRetry: () => void
  /** Opens the «Что нового» dialog. */
  onWhatsNew: () => void
}

/** Global strip above the command bar. Renders nothing unless action or news exists. */
export function UpdateBar({
  view,
  compact = false,
  busy = false,
  onDownload,
  onInstall,
  onRetry,
  onWhatsNew,
}: UpdateBarProps): React.JSX.Element | null {
  const version = view.availableVersion
  if (version === null) return null
  let icon: IconName = 'arrowUp'
  let title: string
  let note: string
  let actions: React.JSX.Element
  let warn = false

  switch (view.state) {
    case 'AVAILABLE':
      title = `Доступна версия ${version}`
      note = 'Обновление займёт около минуты.'
      actions = (
        <>
          {compact ? null : (
            <Button onClick={onWhatsNew} size="sm">
              Что нового
            </Button>
          )}
          <Button loading={busy} onClick={onDownload} size="sm" variant="primary">
            <Icon name="download" size={14} />
            Обновить
          </Button>
        </>
      )
      break
    case 'DOWNLOADING': {
      icon = 'download'
      const percent = Math.round(view.progress?.percent ?? 0)
      title = `Скачиваем версию ${version}`
      note = 'Можно продолжать работать.'
      actions = (
        <div className={styles['progress']}>
          <Progress label="Загрузка обновления" value={percent} />
          <span className={styles['num']}>{percent}%</span>
        </div>
      )
      break
    }
    case 'READY':
      icon = 'checkCircle'
      title = `Версия ${version} скачана`
      note = 'Перезапустите приложение, чтобы установить.'
      actions = (
        <Button loading={busy} onClick={onInstall} size="sm" variant="primary">
          <Icon name="refresh" size={14} />
          {compact ? 'Перезапустить' : 'Перезапустить для установки'}
        </Button>
      )
      break
    case 'FAILED':
      icon = 'wifiOff'
      warn = true
      title = `Не удалось скачать версию ${version}`
      note = view.error?.message ?? 'Прежняя версия работает.'
      actions = (
        <Button loading={busy} onClick={onRetry} size="sm">
          <Icon name="refresh" size={14} />
          Повторить
        </Button>
      )
      break
    default:
      return null
  }

  return (
    <div
      className={cx(styles['bar'], warn && styles['warn'], compact && styles['compact'])}
      role="status"
    >
      <span className={styles['icon']}>
        <Icon name={icon} size={15} />
      </span>
      <div className={styles['text']}>
        <b>{title}</b>
        <span>{note}</span>
      </div>
      <div className={styles['actions']}>{actions}</div>
    </div>
  )
}
