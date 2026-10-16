import { useState } from 'react'

import type { CaptureProfileSummary } from '../../../../shared/models/capture'
import { Button, Dialog, Field, Input } from '../../ui'
import { copyName, profileNameError } from './errors'
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
