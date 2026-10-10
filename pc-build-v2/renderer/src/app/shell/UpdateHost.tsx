import { useState } from 'react'

import { useUpdater } from '../../features/updates'
import { Button, Dialog, DialogNotes, Icon, Progress, UpdateBar } from '../../ui'
import { useTier } from '../useTier'

/** Global update strip + «Что нового» dialog, both on the one real updater controller. */
export function UpdateHost(): React.JSX.Element | null {
  const updater = useUpdater()
  const tier = useTier()
  const [open, setOpen] = useState(false)
  const view = updater.value
  if (view === null) return null
  const percent = Math.round(view.progress?.percent ?? 0)

  return (
    <>
      <UpdateBar
        busy={updater.busy !== null}
        compact={tier === 'mini'}
        onDownload={() => void updater.download()}
        onInstall={() => void updater.install()}
        onRetry={() => void updater.download()}
        onWhatsNew={() => setOpen(true)}
        view={view}
      />
      {open && view.availableVersion !== null ? (
        <Dialog
          description={
            view.state === 'AVAILABLE'
              ? `У вас ${view.currentVersion}. Что нового:`
              : view.state === 'DOWNLOADING'
                ? 'Можно продолжать работать — мониторинг не прерывается.'
                : view.state === 'READY'
                  ? 'Перезапустим приложение, мониторинг запустится сам.'
                  : 'Прежняя версия продолжает работать.'
          }
          footer={
            <>
              <Button onClick={() => setOpen(false)} variant="ghost">
                {view.state === 'AVAILABLE' || view.state === 'READY'
                  ? 'Позже'
                  : 'Закрыть'}
              </Button>
              {view.state === 'AVAILABLE' ? (
                <Button
                  loading={updater.busy === 'download'}
                  onClick={() => void updater.download().then(() => setOpen(false))}
                  variant="primary"
                >
                  <Icon name="download" size={15} />
                  Скачать и обновить
                </Button>
              ) : null}
              {view.state === 'READY' ? (
                <Button
                  loading={updater.busy === 'install'}
                  onClick={() => void updater.install()}
                  variant="primary"
                >
                  <Icon name="refresh" size={15} />
                  Перезапустить
                </Button>
              ) : null}
              {view.state === 'FAILED' ? (
                <Button onClick={() => void updater.download()} variant="primary">
                  <Icon name="refresh" size={15} />
                  Повторить
                </Button>
              ) : null}
            </>
          }
          onClose={() => setOpen(false)}
          title={
            view.state === 'FAILED'
              ? 'Не удалось скачать обновление'
              : `Версия ${view.availableVersion}`
          }
        >
          {view.state === 'DOWNLOADING' ? (
            <Progress label="Загрузка обновления" value={percent} />
          ) : null}
          {view.releaseNotes.length > 0 ? (
            <DialogNotes items={view.releaseNotes} />
          ) : null}
        </Dialog>
      ) : null}
    </>
  )
}
