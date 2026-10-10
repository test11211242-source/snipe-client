import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'

import styles from './Controls.module.css'
import { cx } from './cx'
import { Icon } from './Icon'

export interface FieldProps {
  label: string
  /** Hint under the control; replaced by `error` when present. */
  hint?: ReactNode
  /** What is wrong and what to do. */
  error?: ReactNode
  /** Render the control; spread `controlProps` on it. */
  children: (controlProps: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': true | undefined
  }) => ReactNode
}

/** Label + control + hint/error. Errors are announced and tied by aria-describedby. */
export function Field({ label, hint, error, children }: FieldProps): React.JSX.Element {
  const id = useId()
  const noteId = `${id}-note`
  const hasError = error !== undefined && error !== null && error !== false
  const hasHint = hint !== undefined && hint !== null && hint !== false
  return (
    <div className={styles['field']}>
      <label className={styles['label']} htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': hasError || hasHint ? noteId : undefined,
        'aria-invalid': hasError ? true : undefined,
      })}
      {hasError ? (
        <div className={styles['error']} id={noteId} role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      ) : hasHint ? (
        <div className={styles['hint']} id={noteId}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'md' | 'lg'
  mono?: boolean
}

export function Input({
  size = 'md',
  mono = false,
  className,
  ...rest
}: InputProps): React.JSX.Element {
  return (
    <input
      {...rest}
      className={cx(
        styles['input'],
        size === 'lg' && styles['large'],
        mono && styles['mono'],
        rest['aria-invalid'] === true && styles['invalid'],
        className,
      )}
    />
  )
}

export function Select({
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...rest} className={cx(styles['select'], className)} />
}

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** Accessible name (visible text usually sits next to the switch). */
  label: string
  disabled?: boolean
  id?: string
}

/** role="switch"; applies immediately, Space/Enter toggle. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  id,
}: SwitchProps): React.JSX.Element {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={styles['switch']}
      disabled={disabled}
      id={id}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <i />
    </button>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  /** Accessible name when the label is an icon. */
  ariaLabel?: string
  disabled?: boolean
  /** Why it is unavailable. */
  title?: string
}

export interface SegmentProps<T extends string> {
  value: T
  options: readonly SegmentOption<T>[]
  onChange: (next: T) => void
  /** Accessible name of the group. */
  label: string
  full?: boolean
  className?: string
}

/** 2–4 mutually exclusive values. Group of toggle buttons (aria-pressed). */
export function Segment<T extends string>({
  value,
  options,
  onChange,
  label,
  full = false,
  className,
}: SegmentProps<T>): React.JSX.Element {
  return (
    <div
      aria-label={label}
      className={cx(styles['seg'], full && styles['full'], className)}
      role="group"
    >
      {options.map((option) => (
        <button
          aria-label={option.ariaLabel}
          aria-pressed={option.value === value}
          className={styles['segBtn']}
          disabled={option.disabled}
          key={option.value}
          onClick={() => {
            if (option.value !== value) onChange(option.value)
          }}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export interface StepperProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (next: number) => void
  label: string
  format?: (value: number) => string
  disabled?: boolean
}

/** Stepper with spinbutton semantics; arrows and +/- change the value within bounds. */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format,
  disabled = false,
}: StepperProps): React.JSX.Element {
  const clamp = (next: number): number => Math.min(max, Math.max(min, next))
  return (
    <div
      aria-label={label}
      className={cx(styles['stepper'], disabled && styles['stepperOff'])}
      role="group"
    >
      <button
        aria-label="Уменьшить"
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - step))}
        type="button"
      >
        −
      </button>
      <span
        aria-valuemax={max}
        aria-valuemin={min}
        aria-valuenow={value}
        aria-valuetext={format?.(value)}
        className={styles['stepperValue']}
        onKeyDown={(event) => {
          if (disabled) return
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault()
            onChange(clamp(value + step))
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            event.preventDefault()
            onChange(clamp(value - step))
          }
        }}
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
      >
        {format === undefined ? value : format(value)}
      </span>
      <button
        aria-label="Увеличить"
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + step))}
        type="button"
      >
        +
      </button>
    </div>
  )
}

/** Toggle chip (filters, quick choices). */
export function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      aria-pressed={pressed}
      className={styles['chip']}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

/** Title-builder block ("Место в топе"); the cross removes it. */
export function TitleChip({
  children,
  onRemove,
  removeLabel,
}: {
  children: ReactNode
  onRemove: () => void
  removeLabel: string
}): React.JSX.Element {
  return (
    <span className={styles['titleChip']}>
      {children}
      <button aria-label={removeLabel} onClick={onRemove} type="button">
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}

/** Free-text block of the title builder. */
export function TitleTextChip({
  value,
  onChange,
  onRemove,
  label,
  removeLabel,
}: {
  value: string
  onChange: (next: string) => void
  onRemove: () => void
  label: string
  removeLabel: string
}): React.JSX.Element {
  return (
    <span className={cx(styles['titleChip'], styles['titleChipText'])}>
      <input
        aria-label={label}
        className={styles['titleChipInput']}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={value}
      />
      <button aria-label={removeLabel} onClick={onRemove} type="button">
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}
