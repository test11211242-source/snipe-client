import { useId, useState } from 'react'

import { Button, Status, Toggle } from '../ui'

export function DraftStatus({
  dirty,
  invalid = false,
  saved = false,
}: {
  dirty: boolean
  invalid?: boolean
  saved?: boolean
}): React.JSX.Element {
  const label = invalid
    ? 'Исправьте значения'
    : saved
      ? 'Изменения сохранены'
      : dirty
        ? 'Есть несохранённые изменения'
        : 'Изменения сохранены'
  return (
    <Status
      label={label}
      tone={invalid ? 'danger' : dirty ? 'warning' : 'success'}
      live
    />
  )
}

export function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'success' | 'warning'
}): React.JSX.Element {
  return (
    <div data-tone={tone}>
      <small>{label}</small>
      <strong title={value}>{value}</strong>
    </div>
  )
}

export function Requirement({
  label,
  ready,
}: {
  label: string
  ready: boolean
}): React.JSX.Element {
  return (
    <div data-ready={ready}>
      <i aria-hidden="true" />
      <span>{label}</span>
      <strong>{ready ? 'Готово' : 'Нужно настроить'}</strong>
    </div>
  )
}

export function StreamerToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <Toggle
      className="streamer-toggle"
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

export function NumberField({
  fieldKey,
  label,
  value,
  min,
  max,
  disabled,
  onChange,
  onValidityChange,
}: {
  fieldKey: string
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (value: number) => void
  onValidityChange: (fieldKey: string, invalid: boolean) => void
}): React.JSX.Element {
  const [edit, setEdit] = useState({
    draft: String(value),
    sourceValue: value,
    dirty: false,
  })
  const [focused, setFocused] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()
  const displayedDraft =
    edit.sourceValue !== value && !edit.dirty && !focused ? String(value) : edit.draft

  return (
    <label>
      {label}
      <input
        aria-describedby={invalid ? errorId : undefined}
        aria-invalid={invalid}
        disabled={disabled}
        inputMode="numeric"
        max={max}
        min={min}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value
          const next = Number(nextDraft)
          const nextInvalid =
            nextDraft.trim() === '' || !Number.isInteger(next) || next < min || next > max
          setEdit({
            draft: nextDraft,
            sourceValue: nextInvalid ? value : next,
            dirty: nextInvalid,
          })
          setInvalid(nextInvalid)
          onValidityChange(fieldKey, nextInvalid)
          if (!nextInvalid) onChange(next)
        }}
        onFocus={() => {
          setFocused(true)
          setEdit((current) =>
            current.sourceValue !== value && !current.dirty
              ? { draft: String(value), sourceValue: value, dirty: false }
              : current,
          )
        }}
        type="number"
        value={displayedDraft}
      />
      {invalid && (
        <small className="field-error" id={errorId}>
          Введите целое число от {min} до {max}.
        </small>
      )}
    </label>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  disabled: boolean
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <label>
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {options.map(([option, optionLabel]) => (
          <option key={option} value={option}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

export function ConfirmedButton({
  label,
  disabled,
  prompt,
  action,
}: {
  label: string
  disabled: boolean
  prompt: string
  action: () => Promise<void>
}): React.JSX.Element {
  return (
    <Button
      disabled={disabled}
      onClick={() => {
        if (window.confirm(prompt)) void action()
      }}
    >
      {label}
    </Button>
  )
}
