import { AlertCircle, Download, RefreshCw, X } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'

import type { AppSettingsView } from '../../../shared/contracts/app'
import type { UpdateView } from '../../../shared/models/update'
import type {
  WidgetSettings as WidgetSettingsData,
  WidgetStatus,
} from '../../../shared/models/widget'
import { publicErrorMessage, updateStateLabel } from './format'
import { Alert, AsyncState, Button, PageHeader, Section, Status, Toggle } from './ui'

export function SettingsPage({
  status,
  onStatus,
  appSettings,
  onAppSettings,
  updateView,
  onUpdateView,
}: {
  status: WidgetStatus | null
  onStatus: (status: WidgetStatus) => void
  appSettings: AppSettingsView | null
  onAppSettings: (settings: AppSettingsView) => void
  updateView: UpdateView | null
  onUpdateView: (view: UpdateView) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [opacityDraft, setOpacityDraft] = useState(
    Math.round((status?.settings.opacity ?? 0.95) * 100),
  )
  const [opacityDirty, setOpacityDirty] = useState(false)
  const savedTimer = useRef<number | undefined>(undefined)
  const applyWidgetStatus = useEffectEvent(onStatus)

  useEffect(() => {
    let active = true
    void window.crTools.getWidgetStatus().then(
      (latestStatus) => {
        if (active) applyWidgetStatus(latestStatus)
      },
      () => {
        if (active) setMutationError('Не удалось обновить настройки виджета.')
      },
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(
    () => () => {
      if (savedTimer.current !== undefined) window.clearTimeout(savedTimer.current)
    },
    [],
  )

  const showSaved = (message: string): void => {
    setSavedMessage(message)
    if (savedTimer.current !== undefined) window.clearTimeout(savedTimer.current)
    savedTimer.current = window.setTimeout(() => setSavedMessage(null), 2_500)
  }

  const updateWidget = async (patch: Partial<WidgetSettingsData>): Promise<boolean> => {
    setBusy('widget')
    setMutationError(null)
    try {
      const latestStatus = await window.crTools.getWidgetStatus()
      const settings = await window.crTools.updateWidgetSettings({
        ...latestStatus.settings,
        ...patch,
      })
      onStatus({ ...latestStatus, settings })
      showSaved('Настройки виджета сохранены')
      return true
    } catch {
      setMutationError('Не удалось сохранить настройки виджета.')
      return false
    } finally {
      setBusy(null)
    }
  }

  const updateWidgetEvent = useEffectEvent(updateWidget)

  useEffect(() => {
    if (!opacityDirty) return
    let active = true
    const timer = window.setTimeout(() => {
      void updateWidgetEvent({ opacity: opacityDraft / 100 }).then(() => {
        if (active) setOpacityDirty(false)
      })
    }, 350)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [opacityDirty, opacityDraft])

  const displayedOpacity =
    opacityDirty || status === null
      ? opacityDraft
      : Math.round(status.settings.opacity * 100)

  const showWidget = async (): Promise<void> => {
    setBusy('show-widget')
    setMutationError(null)
    try {
      onStatus(await window.crTools.showWidget())
    } catch {
      setMutationError('Не удалось открыть окно виджета.')
    } finally {
      setBusy(null)
    }
  }

  const updateApplication = async (patch: Partial<AppSettingsView>): Promise<void> => {
    if (appSettings === null) return
    setBusy('application')
    setMutationError(null)
    try {
      onAppSettings(await window.crTools.updateAppSettings({ ...appSettings, ...patch }))
      showSaved('Настройки приложения сохранены')
    } catch {
      setMutationError('Не удалось сохранить настройки приложения.')
    } finally {
      setBusy(null)
    }
  }

  const runUpdateCommand = async (
    command: 'check' | 'download' | 'cancel' | 'install',
  ): Promise<void> => {
    setBusy(`update-${command}`)
    setMutationError(null)
    try {
      const view =
        command === 'check'
          ? await window.crTools.checkForUpdate()
          : command === 'download'
            ? await window.crTools.downloadUpdate()
            : command === 'cancel'
              ? await window.crTools.cancelUpdate()
              : await window.crTools.installUpdate()
      onUpdateView(view)
    } catch {
      setMutationError('Не удалось выполнить операцию с обновлением.')
    } finally {
      setBusy(null)
    }
  }

  const controlsDisabled = busy !== null
  const updateTone =
    updateView?.state === 'FAILED'
      ? 'danger'
      : updateView?.state === 'AVAILABLE' || updateView?.state === 'READY'
        ? 'warning'
        : updateView?.state === 'CHECKING' || updateView?.state === 'DOWNLOADING'
          ? 'loading'
          : 'success'

  return (
    <div className="settings-page">
      <PageHeader
        eyebrow="ПЕРСОНАЛИЗАЦИЯ"
        title="Настройки приложения"
        description="Поведение виджета, системные параметры и обновления CR Tools."
      />

      <div className="settings-feedback" aria-live="polite">
        {mutationError !== null && <Alert>{mutationError}</Alert>}
        {savedMessage !== null && <Alert tone="success">{savedMessage}</Alert>}
      </div>

      <div className="settings-layout">
        <Section
          className="settings-panel settings-widget-panel"
          eyebrow="ОКНО СОПЕРНИКА"
          title="Виджет соперника"
          actions={
            <Button
              disabled={controlsDisabled || status === null}
              onClick={() => void showWidget()}
            >
              Открыть виджет
            </Button>
          }
        >
          <p className="settings-intro">
            Настройте поведение отдельного окна с последним найденным соперником.
          </p>
          {status === null ? (
            <AsyncState
              loading
              title="Загружаем настройки"
              detail="Получаем параметры окна виджета."
            />
          ) : (
            <div className="settings-form">
              <Toggle
                label="Открывать при найденном игроке"
                detail="Ошибки и результаты «не найден» окно не открывают."
                checked={status.settings.autoOpen}
                disabled={controlsDisabled}
                onChange={(autoOpen) => void updateWidget({ autoOpen })}
              />
              <Toggle
                label="Поверх остальных окон"
                detail="Сохраняет колоду видимой рядом с игрой."
                checked={status.settings.alwaysOnTop}
                disabled={controlsDisabled}
                onChange={(alwaysOnTop) => void updateWidget({ alwaysOnTop })}
              />
              <Toggle
                label="Заблокировать положение"
                detail="Отключает перемещение и изменение размера окна."
                checked={status.settings.locked}
                disabled={controlsDisabled}
                onChange={(locked) => void updateWidget({ locked })}
              />
              <Toggle
                label="Компактный режим"
                detail="Уменьшает карточки, сохраняя основные сведения."
                checked={status.settings.compactMode}
                disabled={controlsDisabled}
                onChange={(compactMode) => void updateWidget({ compactMode })}
              />
              <label className="setting-range">
                <span>
                  <strong>Прозрачность</strong>
                  <small>Изменение сохраняется после завершения движения ползунка.</small>
                </span>
                <input
                  aria-label="Прозрачность виджета"
                  type="range"
                  min="55"
                  max="100"
                  step="5"
                  disabled={controlsDisabled}
                  value={displayedOpacity}
                  onChange={(event) => {
                    setOpacityDraft(Number(event.currentTarget.value))
                    setOpacityDirty(true)
                  }}
                />
                <output>{displayedOpacity}%</output>
              </label>
            </div>
          )}
        </Section>

        <Section
          className="settings-panel application-settings"
          eyebrow="ПРИЛОЖЕНИЕ"
          title="Приложение"
        >
          {appSettings === null ? (
            <AsyncState
              loading
              title="Загружаем настройки"
              detail="Получаем параметры приложения."
            />
          ) : (
            <div className="settings-form">
              <Toggle
                label="Уменьшить движение"
                detail="Отключает декоративные анимации и переходы интерфейса."
                checked={appSettings.reducedMotion}
                disabled={controlsDisabled}
                onChange={(reducedMotion) => void updateApplication({ reducedMotion })}
              />
              <Toggle
                label="Запускать вместе с Windows"
                detail="Изменяет системный параметр автозапуска только в Windows."
                checked={appSettings.launchAtStartup}
                disabled={controlsDisabled}
                onChange={(launchAtStartup) =>
                  void updateApplication({ launchAtStartup })
                }
              />
              <Toggle
                label="Подробная локальная диагностика"
                detail="Включает расширенный отладочный вывод приложения. Данные автоматически не отправляются."
                checked={appSettings.diagnosticsEnabled}
                disabled={controlsDisabled}
                onChange={(diagnosticsEnabled) =>
                  void updateApplication({ diagnosticsEnabled })
                }
              />
            </div>
          )}
        </Section>

        <Section
          className="settings-panel update-settings"
          eyebrow="ОБНОВЛЕНИЯ"
          title="Обновления приложения"
          actions={
            <Status
              label={updateStateLabel(updateView?.state ?? null)}
              tone={updateTone}
              live
            />
          }
        >
          <dl className="update-summary">
            <div>
              <dt>Текущая версия</dt>
              <dd>{updateView?.currentVersion ?? 'Проверяем'}</dd>
            </div>
            <div>
              <dt>Доступная версия</dt>
              <dd>{updateView?.availableVersion ?? 'Нет новых версий'}</dd>
            </div>
          </dl>
          {updateView?.progress !== null && updateView?.progress !== undefined && (
            <div className="update-progress" aria-live="polite">
              <div>
                <strong>Загрузка {updateView.progress.percent.toFixed(1)}%</strong>
                <span>
                  {formatBytes(updateView.progress.downloadedBytes)} /{' '}
                  {formatBytes(updateView.progress.totalBytes)}
                </span>
              </div>
              <progress
                aria-label="Ход загрузки обновления"
                value={updateView.progress.downloadedBytes}
                max={updateView.progress.totalBytes}
              />
            </div>
          )}
          {updateView?.error !== null && updateView?.error !== undefined && (
            <Alert
              title="Обновление не выполнено"
              details={<code>{updateView.error.code}</code>}
            >
              {publicErrorMessage(updateView.error.code, updateView.error.message)}
              {updateView.error.retryable ? ' Операцию можно повторить.' : ''}
            </Alert>
          )}
          {updateView !== null && updateView.releaseNotes.length > 0 && (
            <div className="release-notes">
              <strong>
                {updateView.critical ? 'Критическое обновление' : 'Что нового'}
              </strong>
              <ul>
                {updateView.releaseNotes.map((note, index) => (
                  <li key={`${index}-${note}`}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="update-actions">
            <Button
              disabled={
                controlsDisabled ||
                updateView?.state === 'CHECKING' ||
                updateView?.state === 'DOWNLOADING'
              }
              onClick={() => void runUpdateCommand('check')}
            >
              <RefreshCw aria-hidden="true" size={16} />
              Проверить
            </Button>
            {updateView?.state === 'AVAILABLE' && (
              <Button
                variant="primary"
                disabled={controlsDisabled}
                onClick={() => void runUpdateCommand('download')}
              >
                <Download aria-hidden="true" size={16} />
                Скачать
              </Button>
            )}
            {updateView?.state === 'DOWNLOADING' && (
              <Button variant="danger" onClick={() => void runUpdateCommand('cancel')}>
                <X aria-hidden="true" size={16} />
                Отменить
              </Button>
            )}
            {updateView?.state === 'READY' && (
              <Button
                variant="primary"
                disabled={controlsDisabled}
                onClick={() => void runUpdateCommand('install')}
              >
                Установить и перезапустить
              </Button>
            )}
          </div>
        </Section>

        <aside className="windows-warning" role="note">
          <AlertCircle aria-hidden="true" size={19} />
          <div>
            <strong>Предупреждение Windows</strong>
            <p>
              Windows может показать сообщение «Неизвестный издатель». Перед установкой
              приложение отдельно проверяет источник и целостность обновления.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КиБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`
}
