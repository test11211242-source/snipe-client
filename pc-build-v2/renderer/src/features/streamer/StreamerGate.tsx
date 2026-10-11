import type { ReactNode } from 'react'

import { Banner, Button, Icon, State } from '../../ui'
import { useStreamer } from './streamerContext'
import { REFRESH_SECTION_LABELS } from './text'

/**
 * Loading / failure / access states shared by every streamer page, plus the notice for
 * sections the server could not refresh (the rest of the page keeps its last good data).
 */
export function StreamerGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { view, loading, loadFailed, reload } = useStreamer()

  if (view === null) {
    if (loadFailed)
      return (
        <State
          actions={
            <Button onClick={() => void reload()} variant="primary">
              <Icon name="refresh" size={15} />
              Повторить
            </Button>
          }
          icon="wifiOff"
          title="Не удалось открыть раздел эфира"
          tone="warn"
        >
          Нет связи с сервером или приложение не ответило. Проверьте интернет и повторите.
        </State>
      )
    return (
      <State
        icon="clock"
        pulse
        title={loading ? 'Загружаем состояние эфира' : 'Ждём данные'}
      >
        Получаем Twitch, прогнозы, название и виджеты.
      </State>
    )
  }

  if (!view.access.allowed)
    return (
      <State icon="lock" title="Сервер не разрешил доступ" tone="warn">
        {view.access.reason ??
          'Проверьте права активной учётной записи и войдите в аккаунт заново.'}
      </State>
    )

  const failed = view.refresh.errors.map(
    (item) => REFRESH_SECTION_LABELS[item.section] ?? item.section,
  )
  return (
    <>
      {failed.length > 0 ? (
        <Banner
          actions={
            <Button onClick={() => void reload()} size="sm">
              <Icon name="refresh" size={14} />
              Обновить
            </Button>
          }
          icon="alert"
          title="Часть данных не обновилась"
          tone="warn"
        >
          Не получили: {failed.join(', ')}. Остальное показано как было.
        </Banner>
      ) : null}
      {children}
    </>
  )
}
