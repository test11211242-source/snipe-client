import type { UpdateView } from '../../../../shared/models/update'
import {
  Banner,
  Button,
  DialogNotes,
  Icon,
  Pill,
  Progress,
  Skeleton,
  cx,
  type IconName,
} from '../../ui'
import { useUpdater } from '../updates'
import styles from './Settings.module.css'

const formatBytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} МБ`

interface Presentation {
  icon: IconName
  warn: boolean
  title: string
  sub: string
}

function present(view: UpdateView): Presentation {
  const installed = `Сейчас установлена ${view.currentVersion}`
  switch (view.state) {
    case 'IDLE':
      return {
        icon: 'refresh',
        warn: false,
        title: 'Обновления ещё не проверялись',
        sub: installed,
      }
    case 'AVAILABLE':
      return {
        icon: 'arrowUp',
        warn: false,
        title: `Версия ${view.availableVersion ?? ''}`,
        sub: installed,
      }
    case 'DOWNLOADING':
      return {
        icon: 'download',
        warn: false,
        title: `Скачиваем версию ${view.availableVersion ?? ''}`,
        sub: 'Можно продолжать работать — мониторинг не прерывается.',
      }
    case 'READY':
      return {
        icon: 'checkCircle',
        warn: false,
        title: `Версия ${view.availableVersion ?? ''} скачана`,
        sub: 'Перезапустим приложение, ваши настройки сохранятся.',
      }
    case 'FAILED':
      return {
        icon: 'wifiOff',
        warn: true,
        title: 'Обновление не удалось',
        sub: 'Прежняя версия продолжает работать.',
      }
    case 'CHECKING':
      return {
        icon: 'refresh',
        warn: false,
        title: 'Проверяем обновления…',
        sub: installed,
      }
    default:
      return {
        icon: 'checkCircle',
        warn: false,
        title: 'Установлена актуальная версия',
        sub: `Версия ${view.currentVersion}`,
      }
  }
}

/** «Обновления»: version, notes, progress, errors and the check/download/install actions. */
export function UpdatesPage(): React.JSX.Element {
  const updater = useUpdater()
  const view = updater.value
  if (view === null)
    return (
      <div className={styles['page']}>
        {updater.error === null ? (
          <Skeleton height={160} />
        ) : (
          <Banner
            actions={
              <Button onClick={() => void updater.reload()} size="sm">
                Повторить
              </Button>
            }
            icon="wifiOff"
            title="Не удалось получить состояние обновлений"
            tone="warn"
          >
            {updater.error.message}
          </Banner>
        )}
      </div>
    )

  const shown = present(view)
  const percent = Math.round(view.progress?.percent ?? 0)
  const busy = updater.busy !== null
  const failedDownload = view.state === 'FAILED' && view.availableVersion !== null

  return (
    <div className={styles['page']}>
      {updater.actionError === null ? null : (
        <Banner icon="alert" title="Не получилось" tone="danger">
          {updater.actionError}
        </Banner>
      )}
      <section aria-label="Обновление приложения" className={styles['update']}>
        <div className={styles['updateHead']}>
          <span className={cx(styles['updateIcon'], shown.warn && styles['updateWarn'])}>
            <Icon name={shown.icon} size={22} />
          </span>
          <div>
            <b>{shown.title}</b>
            <span>{shown.sub}</span>
          </div>
          {view.critical && view.availableVersion !== null ? (
            <Pill tone="warn">Обязательное обновление</Pill>
          ) : null}
        </div>
        {view.releaseNotes.length > 0 ? <DialogNotes items={view.releaseNotes} /> : null}
        {view.state === 'DOWNLOADING' ? (
          <div>
            <Progress label="Загрузка обновления" value={percent} />
            <div className={styles['progressMeta']}>
              <span>
                {view.progress === null
                  ? 'Начинаем загрузку…'
                  : `Скачано ${formatBytes(view.progress.downloadedBytes)} из ${formatBytes(view.progress.totalBytes)}`}
              </span>
              <span>{percent}%</span>
            </div>
          </div>
        ) : null}
        {view.error === null ? null : (
          <Banner
            icon="alert"
            title={view.state === 'FAILED' ? 'Что пошло не так' : 'Предупреждение'}
            tone={view.state === 'FAILED' ? 'danger' : 'warn'}
          >
            {view.error.message}
            {view.error.retryable ? ' Попробуйте ещё раз.' : ''}
          </Banner>
        )}
        <div className={styles['actions']}>
          {view.state === 'AVAILABLE' ? (
            <Button
              loading={updater.busy === 'download'}
              onClick={() => void updater.download()}
              variant="primary"
            >
              <Icon name="download" size={15} />
              Скачать и обновить
            </Button>
          ) : null}
          {view.state === 'DOWNLOADING' ? (
            <Button
              loading={updater.busy === 'cancel'}
              onClick={() => void updater.cancel()}
              variant="danger"
            >
              Отменить загрузку
            </Button>
          ) : null}
          {view.state === 'READY' ? (
            <Button
              loading={updater.busy === 'install'}
              onClick={() => void updater.install()}
              variant="primary"
            >
              <Icon name="refresh" size={15} />
              Перезапустить для установки
            </Button>
          ) : null}
          {failedDownload ? (
            <Button
              loading={updater.busy === 'download'}
              onClick={() => void updater.download()}
              variant="primary"
            >
              <Icon name="refresh" size={15} />
              Повторить загрузку
            </Button>
          ) : null}
          <Button
            disabled={busy || view.state === 'DOWNLOADING' || view.state === 'READY'}
            loading={updater.busy === 'check' || view.state === 'CHECKING'}
            onClick={() => void updater.check()}
          >
            <Icon name="refresh" size={15} />
            Проверить обновления
          </Button>
        </div>
      </section>
    </div>
  )
}
