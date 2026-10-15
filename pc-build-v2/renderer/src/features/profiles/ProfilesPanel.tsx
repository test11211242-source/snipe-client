import { useState } from 'react'

import {
  MAX_CAPTURE_PROFILES,
  type CaptureProfileSummary,
} from '../../../../shared/models/capture'
import { presentedMonitorState } from '../../../../shared/models/monitor'
import { useRouter, type SetupIntent } from '../../app/router'
import { Button, ConfirmDialog, Icon, Panel, State, useToast } from '../../ui'
import { useRole } from '../auth'
import { useMonitorView } from '../monitor'
import { ResultZoneDialog, DuplicateDialog, type ResultZoneStart } from './ProfileDialogs'
import { ProfileRow } from './ProfileRow'
import styles from './ProfilesPanel.module.css'
import { useProfiles } from './index'

type Dialog =
  | { kind: 'duplicate'; profileId: string }
  | { kind: 'delete'; profileId: string }
  | { kind: 'zone'; profileId: string }

/**
 * Profiles side panel: list, activate, rename, duplicate, delete (with confirmation),
 * rebind source, re-calibrate and per-profile result zones. Health comes from main's
 * profile fields; nothing is inferred here. Setup itself is the full-window `setup` route.
 */
export function ProfilesPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const profiles = useProfiles()
  const { value, error, activate, pending, actionError, reload } = profiles
  const monitor = useMonitorView()
  const { isStreamer } = useRole()
  const { navigate } = useRouter()
  const toast = useToast()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const waiting =
    monitor.value !== null && presentedMonitorState(monitor.value) === 'WAITING_SOURCE'
  const list = value?.profiles ?? []
  const count = list.length
  const full = count >= MAX_CAPTURE_PROFILES
  const target: CaptureProfileSummary | null =
    dialog === null
      ? null
      : (list.find((item) => item.profileId === dialog.profileId) ?? null)

  const openSetup = (intent: SetupIntent): void => {
    onClose()
    navigate({ name: 'setup', intent })
  }
  const intentFor = (
    kind: 'recalibrate' | 'rebind',
    profile: CaptureProfileSummary,
  ): SetupIntent | null =>
    value?.revision == null
      ? null
      : {
          kind,
          profileId: profile.profileId,
          profileName: profile.profileName,
          expectedRevision: value.revision,
        }

  const startSetup = (
    kind: 'recalibrate' | 'rebind',
    profile: CaptureProfileSummary,
  ): void => {
    const intent = intentFor(kind, profile)
    if (intent !== null) openSetup(intent)
  }

  const startResultZone = async (
    profile: CaptureProfileSummary,
  ): Promise<ResultZoneStart | null> => {
    if (value?.revision == null)
      return { message: 'Список профилей ещё не загружен.', activeSetup: false }
    try {
      await window.crTools.setup.startResult({
        profileId: profile.profileId,
        expectedRevision: value.revision,
      })
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : ''
      void reload()
      if (text.includes('already active'))
        return {
          message: 'Уже открыта другая настройка. Завершите её или отмените.',
          activeSetup: true,
        }
      if (text.includes('Capture profiles changed'))
        return {
          message: 'Список профилей изменился. Мы его обновили — повторите.',
          activeSetup: false,
        }
      if (text.includes('different aspect') || text.includes('rebind'))
        return {
          message: 'Источник профиля нужно выбрать заново.',
          activeSetup: false,
        }
      return {
        message:
          'Не удалось сделать кадр. Откройте игру, не сворачивайте окно и повторите.',
        activeSetup: false,
      }
    }
    openSetup({ kind: 'resume' })
    return null
  }

  return (
    <>
      <Panel
        footer={
          <>
            <span className={styles['footNote']}>
              {count} из {MAX_CAPTURE_PROFILES}
              {monitor.value?.runIntent === true
                ? ' · мониторинг не прерывается во время настройки'
                : ''}
            </span>
            <Button
              disabled={value === null || full}
              onClick={() => openSetup({ kind: 'new' })}
              title={full ? 'Достигнут предел — 20 профилей' : undefined}
              variant="primary"
            >
              <Icon name="plus" size={15} />
              Новый профиль
            </Button>
          </>
        }
        onClose={() => {
          // Esc inside the inline editor only cancels the rename.
          if (editingId !== null && document.activeElement instanceof HTMLInputElement)
            setEditingId(null)
          else onClose()
        }}
        title="Профили"
      >
        {value === null ? (
          <State
            actions={
              error === null ? undefined : (
                <Button onClick={() => void reload()}>
                  <Icon name="refresh" size={15} />
                  Повторить
                </Button>
              )
            }
            icon={error === null ? 'clock' : 'alert'}
            title={error === null ? 'Загружаем профили' : 'Профили недоступны'}
            tone={error === null ? 'neutral' : 'danger'}
          >
            {error?.message}
          </State>
        ) : count === 0 ? (
          <State
            actions={
              <Button onClick={() => openSetup({ kind: 'new' })} variant="primary">
                <Icon name="plus" size={15} />
                Создать профиль
              </Button>
            }
            icon="wand"
            title="Профилей пока нет"
          >
            Профиль — это окно или экран игры и положение триггера.
          </State>
        ) : (
          <>
            <p className={styles['intro']}>
              Профиль хранит источник картинки и положение триггера с ником. Для экрана
              другого типа создайте отдельный профиль: триггер у каждого свой.
            </p>
            <div className={styles['list']} role="list">
              {list.map((profile) => (
                <div key={profile.profileId} role="listitem">
                  <ProfileRow
                    actions={{
                      activate: () => void activate(profile.profileId),
                      startRename: () => setEditingId(profile.profileId),
                      cancelRename: () => setEditingId(null),
                      rename: async (name) => {
                        const outcome = await profiles.rename(profile.profileId, name)
                        if (outcome.ok) setEditingId(null)
                        return outcome.ok ? null : outcome.message
                      },
                      duplicate: () =>
                        setDialog({ kind: 'duplicate', profileId: profile.profileId }),
                      rebind: () => startSetup('rebind', profile),
                      recalibrate: () => startSetup('recalibrate', profile),
                      resultZone: () =>
                        setDialog({ kind: 'zone', profileId: profile.profileId }),
                      remove: () => {
                        setDeleteError(null)
                        setDialog({ kind: 'delete', profileId: profile.profileId })
                      },
                    }}
                    all={list}
                    busy={pending}
                    canDelete={count > 1}
                    editing={editingId === profile.profileId}
                    isStreamer={isStreamer}
                    profile={profile}
                    waiting={waiting}
                  />
                </div>
              ))}
            </div>
          </>
        )}
        {actionError === null ? null : (
          <p className={styles['error']} role="alert">
            {actionError}
          </p>
        )}
      </Panel>

      {dialog?.kind === 'duplicate' && target !== null ? (
        <DuplicateDialog
          all={list}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const outcome = await profiles.duplicate(target.profileId, name)
            if (!outcome.ok) return outcome.message
            setDialog(null)
            const copy = outcome.profiles.profiles.find(
              (item) => item.profileName === name,
            )
            const revision = outcome.profiles.revision
            toast.show({
              message: `Копия «${name}» создана`,
              ...(copy === undefined || revision === null
                ? {}
                : {
                    action: {
                      label: 'Выбрать другое окно',
                      onAction: () =>
                        openSetup({
                          kind: 'rebind',
                          profileId: copy.profileId,
                          profileName: copy.profileName,
                          expectedRevision: revision,
                        }),
                    },
                  }),
            })
            return null
          }}
          profile={target}
        />
      ) : null}

      {dialog?.kind === 'delete' && target !== null ? (
        <ConfirmDialog
          confirmLabel="Удалить"
          error={deleteError}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDeleteError(null)
            void profiles.remove(target.profileId).then((outcome) => {
              if (outcome.ok) setDialog(null)
              else setDeleteError(outcome.message)
            })
          }}
          pending={pending}
          text={
            target.isActive
              ? 'Профиль активен: мониторинг остановится. Источник и области этого профиля придётся настраивать заново.'
              : 'Источник и области этого профиля придётся настраивать заново. Остальные профили не изменятся.'
          }
          title={`Удалить профиль «${target.profileName}»?`}
        />
      ) : null}

      {dialog?.kind === 'zone' && target !== null ? (
        <ResultZoneDialog
          onClose={() => setDialog(null)}
          onResume={() => openSetup({ kind: 'resume' })}
          onStart={() => startResultZone(target)}
          profile={target}
        />
      ) : null}
    </>
  )
}
