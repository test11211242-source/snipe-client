import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { hasStreamerRole, type AuthView } from '../../../shared/models/auth'
import type { StreamerView } from '../../../shared/models/streamer'
import { ObsTab } from './streamer/ObsTab'
import { OverviewTab } from './streamer/OverviewTab'
import { PredictionsTab } from './streamer/PredictionsTab'
import { TitleTab } from './streamer/TitleTab'
import { refreshSectionLabel } from './streamer/state'
import type { StreamerRunner } from './streamer/types'
import { Alert, AsyncState, Button, Tabs } from './ui'

type StreamerTab = 'overview' | 'predictions' | 'title' | 'obs'

const STREAMER_TABS = [
  { id: 'overview', label: 'Обзор' },
  { id: 'predictions', label: 'Twitch и прогнозы' },
  { id: 'title', label: 'Название стрима' },
  { id: 'obs', label: 'OBS' },
] as const

export function StreamerPage({ auth }: { auth: AuthView | null }): React.JSX.Element {
  const [tab, setTab] = useState<StreamerTab>('overview')
  const [view, setView] = useState<StreamerView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const roleAllowed = hasStreamerRole(auth)

  useEffect(() => {
    if (!roleAllowed) return
    let active = true
    const isActive = (): boolean => active

    const load = async (): Promise<void> => {
      setBusy('initial')
      setError(null)
      try {
        const initialView = await window.crTools.setStreamerSectionActive(true)
        if (!isActive()) return
        setView(initialView)
        try {
          const refreshedView = await window.crTools.refreshStreamer()
          if (isActive()) setView(refreshedView)
        } catch {
          if (isActive()) setError('Часть данных трансляции пока не обновилась.')
        }
      } catch {
        if (isActive()) setError('Не удалось открыть рабочее пространство стримера.')
      } finally {
        if (isActive()) setBusy(null)
      }
    }

    void load()
    return () => {
      active = false
      void window.crTools.setStreamerSectionActive(false).catch(() => undefined)
    }
  }, [attempt, roleAllowed])

  const run: StreamerRunner = async (name, operation) => {
    setBusy(name)
    setError(null)
    try {
      const nextView = await operation()
      setView(nextView)
      return nextView
    } catch {
      setError(operationError(name))
      return null
    } finally {
      setBusy(null)
    }
  }

  if (auth === null || auth.state === 'BOOTSTRAPPING') {
    return (
      <AsyncState
        loading
        title="Проверяем доступ"
        detail="Получаем роль и разрешения активного профиля."
      />
    )
  }

  if (!roleAllowed) {
    return (
      <section className="streamer-denied">
        <AlertTriangle aria-hidden="true" size={23} />
        <span className="eyebrow">ДОСТУП ОГРАНИЧЕН</span>
        <h2>Нужна роль стримера</h2>
        <p>
          Управление трансляцией доступно профилям с ролью «Стример». Проверьте активный
          аккаунт и войдите снова.
        </p>
      </section>
    )
  }

  if (view === null) {
    return (
      <AsyncState
        loading={error === null}
        title={
          error === null
            ? 'Загружаем состояние трансляции'
            : 'Рабочее пространство недоступно'
        }
        detail={error ?? 'Получаем настройки Twitch, автоматизации и OBS.'}
        action={
          error !== null ? (
            <Button
              variant="primary"
              disabled={busy !== null}
              onClick={() => setAttempt((current) => current + 1)}
            >
              Повторить
            </Button>
          ) : undefined
        }
      />
    )
  }

  if (!view.access.allowed) {
    return (
      <section className="streamer-denied">
        <AlertTriangle aria-hidden="true" size={23} />
        <span className="eyebrow">ДОСТУП ОГРАНИЧЕН</span>
        <h2>Сервер не разрешил доступ</h2>
        <p>
          {view.access.reason ?? 'Проверьте права активного профиля и войдите снова.'}
        </p>
      </section>
    )
  }

  return (
    <div className="streamer-workspace" aria-busy={busy !== null}>
      <div className="streamer-toolbar">
        <Tabs
          className="streamer-tabs"
          id="streamer"
          label="Разделы стримера"
          tabs={STREAMER_TABS}
          value={tab}
          onChange={setTab}
        />
        <div className="streamer-sync">
          <span aria-live="polite">
            {busy === 'refresh' ? 'Обновляем данные' : refreshLabel(view)}
          </span>
          <Button
            disabled={busy !== null}
            onClick={() => void run('refresh', window.crTools.refreshStreamer)}
          >
            <RefreshCw
              className={busy === 'refresh' ? 'is-spinning' : undefined}
              size={16}
              aria-hidden="true"
            />
            Обновить
          </Button>
        </div>
      </div>

      <div className="streamer-notices">
        {error !== null && <Alert>{error}</Alert>}
        {view.refresh.errors.length > 0 && (
          <Alert tone="warning" title="Получены частичные данные">
            Недоступны:{' '}
            {view.refresh.errors
              .map((item) => refreshSectionLabel(item.section))
              .join(', ')}
            .
          </Alert>
        )}
      </div>

      <section
        className="streamer-tab-content"
        hidden={tab !== 'overview'}
        id="streamer-panel-overview"
        role="tabpanel"
        aria-labelledby="streamer-tab-overview"
      >
        <OverviewTab view={view} busy={busy} run={run} />
      </section>
      <section
        className="streamer-tab-content"
        hidden={tab !== 'predictions'}
        id="streamer-panel-predictions"
        role="tabpanel"
        aria-labelledby="streamer-tab-predictions"
      >
        <PredictionsTab view={view} busy={busy} run={run} />
      </section>
      <section
        className="streamer-tab-content"
        hidden={tab !== 'title'}
        id="streamer-panel-title"
        role="tabpanel"
        aria-labelledby="streamer-tab-title"
      >
        <TitleTab view={view} busy={busy} run={run} />
      </section>
      <section
        className="streamer-tab-content"
        hidden={tab !== 'obs'}
        id="streamer-panel-obs"
        role="tabpanel"
        aria-labelledby="streamer-tab-obs"
      >
        <ObsTab view={view} busy={busy} run={run} />
      </section>
    </div>
  )
}

function refreshLabel(view: StreamerView): string {
  if (view.refresh.refreshedAt === null) return 'Данные ещё не обновлялись'
  const refreshedAt = new Date(view.refresh.refreshedAt)
  if (Number.isNaN(refreshedAt.getTime())) return 'Данные обновлены'
  return `Обновлено в ${refreshedAt.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

function operationError(name: string): string {
  if (name.startsWith('copy-')) return 'Не удалось скопировать ссылку OBS.'
  if (name.includes('save') || name.includes('overlay')) {
    return 'Не удалось сохранить настройки. Проверьте значения и повторите.'
  }
  if (name.includes('account')) return 'Не удалось изменить список аккаунтов.'
  if (name === 'refresh') return 'Не удалось обновить данные трансляции.'
  return 'Операция не выполнена. Повторите попытку.'
}
