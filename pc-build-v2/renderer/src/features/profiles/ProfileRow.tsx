import { useState, type ReactNode } from 'react'

import type { CaptureProfileSummary } from '../../../../shared/models/capture'
import {
  Button,
  Field,
  Icon,
  Input,
  LinkButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Pill,
  cx,
  type IconName,
} from '../../ui'
import { profileNameError } from './errors'
import { profileHealth, profileNotes } from './health'
import styles from './ProfilesPanel.module.css'

export interface ProfileRowActions {
  activate: () => void
  rename: (name: string) => Promise<string | null>
  startRename: () => void
  cancelRename: () => void
  duplicate: () => void
  rebind: () => void
  recalibrate: () => void
  resultZone: () => void
  remove: () => void
}

function MenuEntry({
  icon,
  title,
  sub,
}: {
  icon: IconName
  title: string
  sub?: string | undefined
}): ReactNode {
  return (
    <>
      <span className={styles['menuLead']}>
        <Icon name={icon} size={15} />
      </span>
      <span className={styles['menuMain']}>
        <span className={styles['menuTitle']}>{title}</span>
        {sub === undefined ? null : <span className={styles['menuSub']}>{sub}</span>}
      </span>
    </>
  )
}

function RenameEditor({
  profile,
  all,
  onSubmit,
  onCancel,
}: {
  profile: CaptureProfileSummary
  all: readonly CaptureProfileSummary[]
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(profile.profileName)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    const invalid = profileNameError(value, all, profile.profileId)
    if (invalid !== null) {
      setError(invalid)
      return
    }
    if (value.trim() === profile.profileName) {
      onCancel()
      return
    }
    setSaving(true)
    setError(null)
    const failure = await onSubmit(value.trim())
    // Success unmounts this editor; only a failure keeps it open.
    if (failure !== null) {
      setError(failure)
      setSaving(false)
    }
  }

  return (
    <>
      <div className={styles['edit']}>
        <Field
          error={error}
          hint="Enter — сохранить, Esc — отмена"
          label="Название профиля"
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              autoFocus
              disabled={saving}
              maxLength={90}
              onChange={(event) => {
                setValue(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
              value={value}
            />
          )}
        </Field>
      </div>
      <div className={styles['editActions']}>
        <Button
          loading={saving}
          onClick={() => void submit()}
          size="sm"
          variant="primary"
        >
          Сохранить
        </Button>
        <Button disabled={saving} onClick={onCancel} size="sm" variant="ghost">
          Отмена
        </Button>
      </div>
    </>
  )
}

export function ProfileRow({
  profile,
  all,
  waiting,
  isStreamer,
  busy,
  editing,
  canDelete,
  actions,
}: {
  profile: CaptureProfileSummary
  all: readonly CaptureProfileSummary[]
  waiting: boolean
  isStreamer: boolean
  busy: boolean
  editing: boolean
  canDelete: boolean
  actions: ProfileRowActions
}): React.JSX.Element {
  const health = profileHealth(profile, waiting)
  const notes = profileNotes(profile)
  const lead = (
    <span className={styles['lead']}>
      <Icon name={profile.sourceKind === 'display' ? 'monitor' : 'window'} size={16} />
      <i className={cx(styles['health'], health.warn && styles['healthWarn'])} />
    </span>
  )

  if (editing)
    return (
      <div className={cx(styles['row'], profile.isActive && styles['rowActive'])}>
        {lead}
        <RenameEditor
          all={all}
          onCancel={actions.cancelRename}
          onSubmit={actions.rename}
          profile={profile}
        />
      </div>
    )

  return (
    <div
      aria-label={profile.profileName}
      className={cx(styles['row'], profile.isActive && styles['rowActive'])}
      role="group"
    >
      {lead}
      <div className={styles['main']}>
        <span className={styles['title']}>{profile.profileName}</span>
        <span className={cx(styles['sub'], health.warn && styles['subWarn'])}>
          {profile.sourceLabel}
          {health.text === '' ? '' : ` · ${health.text}`}
        </span>
        {notes.rebind === null ? null : (
          <span className={cx(styles['line'], styles['lineWarn'])}>
            <Icon name="alert" size={12} />
            {notes.rebind}
            <LinkButton onClick={actions.rebind} tone="accent">
              Выбрать окно
            </LinkButton>
          </span>
        )}
        {notes.calibration === null ? null : (
          <span
            className={cx(
              styles['line'],
              notes.calibration.warn ? styles['lineWarn'] : styles['lineOk'],
            )}
          >
            <Icon name={notes.calibration.warn ? 'alert' : 'info'} size={12} />
            {notes.calibration.text}
            {notes.calibration.warn ? (
              <LinkButton onClick={actions.recalibrate} tone="accent">
                Перенастроить
              </LinkButton>
            ) : null}
          </span>
        )}
        {isStreamer ? (
          <span
            className={cx(
              styles['line'],
              profile.resultConfigured ? styles['lineOk'] : styles['lineWarn'],
            )}
          >
            <Icon name={profile.resultConfigured ? 'check' : 'alert'} size={12} />
            Зоны результата: {profile.resultConfigured ? 'настроены' : 'нет'}
            {profile.resultConfigured ? null : (
              <LinkButton onClick={actions.resultZone} tone="accent">
                Настроить
              </LinkButton>
            )}
          </span>
        ) : null}
      </div>
      <div className={styles['trail']}>
        {profile.isActive ? (
          <Pill tone="ok">Активный</Pill>
        ) : (
          <Button disabled={busy} onClick={actions.activate} size="sm">
            Сделать активным
          </Button>
        )}
        <Menu
          align="end"
          label={`Действия с профилем «${profile.profileName}»`}
          trigger={({ props }) => (
            <Button
              {...props}
              aria-label={`Действия с профилем «${profile.profileName}»`}
              size="sm"
              variant="ghost"
            >
              <Icon name="more" size={16} />
            </Button>
          )}
          width={280}
        >
          <MenuItem onSelect={actions.startRename}>
            <MenuEntry icon="edit" title="Переименовать" />
          </MenuItem>
          <MenuItem onSelect={actions.duplicate}>
            <MenuEntry icon="copy" title="Дублировать" />
          </MenuItem>
          <MenuItem onSelect={actions.rebind}>
            <MenuEntry
              icon="window"
              sub="Только привязать другое окно или экран"
              title="Сменить источник"
            />
          </MenuItem>
          <MenuItem onSelect={actions.recalibrate}>
            <MenuEntry
              icon="wand"
              sub="Заново выбрать окно и отметить области вручную"
              title="Перенастроить"
            />
          </MenuItem>
          {isStreamer ? (
            <MenuItem onSelect={actions.resultZone}>
              <MenuEntry
                icon="target"
                sub="Область итога боя для прогнозов"
                title={
                  profile.resultConfigured
                    ? 'Перенастроить зоны результата'
                    : 'Зоны результата'
                }
              />
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem danger disabled={!canDelete} onSelect={actions.remove}>
            <MenuEntry
              icon="trash"
              sub={canDelete ? undefined : 'Единственный профиль удалить нельзя'}
              title="Удалить…"
            />
          </MenuItem>
        </Menu>
      </div>
    </div>
  )
}
