import { useState } from 'react'

import type { CaptureProfileSummary } from '../../../../shared/models/capture'
import { Banner, Button, Dialog, Field, Input } from '../../ui'
import { copyName, profileNameError } from './errors'
import { sourceUsable } from './health'
import styles from './ProfilesPanel.module.css'

export function DuplicateDialog({
  profile,
  all,
  onSubmit,
  onClose,
}: {
  profile: CaptureProfileSummary
  all: readonly CaptureProfileSummary[]
  /** Resolves with the failure text, or `null` when the copy was created. */
  onSubmit: (name: string) => Promise<string | null>
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(() => copyName(profile.profileName, all))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    const invalid = profileNameError(name, all, null)
    if (invalid !== null) {
      setError(invalid)
      return
    }
    setSaving(true)
    setError(null)
    const failure = await onSubmit(name.trim())
    if (failure !== null) {
      setError(failure)
      setSaving(false)
    }
  }

  return (
    <Dialog
      description="Копия получит те же источник и области. Затем её можно привязать к другому окну."
      footer={
        <>
          <Button disabled={saving} onClick={onClose} variant="ghost">
            Отмена
          </Button>
          <Button loading={saving} onClick={() => void submit()} variant="primary">
            Создать копию
          </Button>
        </>
      }
      onClose={saving ? () => undefined : onClose}
      title={`Дублировать «${profile.profileName}»`}
    >
      <form
        className={styles['dialogForm']}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Field error={error} label="Название копии">
          {(controlProps) => (
            <Input
              {...controlProps}
              autoFocus
              disabled={saving}
              maxLength={90}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              value={name}
            />
          )}
        </Field>
      </form>
    </Dialog>
  )
}

export interface ResultZoneStart {
  /** Failure text; `activeSetup` when another setup session is already open. */
  message: string
  activeSetup: boolean
}

/** Explains what the frame grab does before `setup.startResult` is called. */
export function ResultZoneDialog({
  profile,
  onStart,
  onResume,
  onClose,
}: {
  profile: CaptureProfileSummary
  /** Resolves with the failure, or `null` when the session started (the caller navigates). */
  onStart: () => Promise<ResultZoneStart | null>
  onResume: () => void
  onClose: () => void
}): React.JSX.Element {
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<ResultZoneStart | null>(null)
  const usable = sourceUsable(profile)

  const start = async (): Promise<void> => {
    setStarting(true)
    setFailure(null)
    const result = await onStart()
    if (result !== null) {
      setFailure(result)
      setStarting(false)
    }
  }

  return (
    <Dialog
      description="Откройте в игре экран с итогом боя — победа или поражение, неважно — и нажмите «Сделать кадр». Приложение сфотографирует окно профиля, а зоны вы отметите вручную."
      footer={
        <>
          <Button disabled={starting} onClick={onClose} variant="ghost">
            Отмена
          </Button>
          {failure?.activeSetup === true ? (
            <Button onClick={onResume}>Открыть начатую настройку</Button>
          ) : null}
          <Button
            disabled={!usable}
            loading={starting}
            onClick={() => void start()}
            variant="primary"
          >
            Сделать кадр
          </Button>
        </>
      }
      onClose={starting ? () => undefined : onClose}
      title={`Зоны результата — «${profile.profileName}»`}
    >
      <div className={styles['dialogForm']}>
        {usable ? null : (
          <Banner icon="alert" title="Источник профиля недоступен" tone="warn">
            Откройте игру или выберите окно профиля заново — без картинки кадр сделать
            нельзя.
          </Banner>
        )}
        {failure === null ? null : (
          <Banner icon="alert" live title="Не получилось" tone="danger">
            {failure.message}
          </Banner>
        )}
      </div>
    </Dialog>
  )
}
