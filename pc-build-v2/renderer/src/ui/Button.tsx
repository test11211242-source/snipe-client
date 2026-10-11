import type { ButtonHTMLAttributes, ReactNode } from 'react'

import styles from './Button.module.css'
import { cx } from './cx'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'dangerSolid'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and ignores clicks; the label stays. */
  loading?: boolean | undefined
}

/** Text button. `type` defaults to "button". */
export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      aria-busy={loading || undefined}
      className={cx(
        styles['btn'],
        variant !== 'default' && styles[variant],
        size !== 'md' && styles[size],
        loading && styles['loading'],
        className,
      )}
      type={type}
    >
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label'> {
  /** Required: icon-only controls need an accessible name. */
  label: string
  /** Highlights the icon (current page). */
  active?: boolean
  children: ReactNode
}

/** Square icon button; `label` becomes aria-label and tooltip. */
export function IconButton({
  label,
  active = false,
  variant = 'ghost',
  size = 'md',
  className,
  children,
  title,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <Button
      {...rest}
      aria-label={label}
      className={cx(
        styles['icon'],
        size !== 'md' && styles[size],
        active && styles['active'],
        className,
      )}
      size={size}
      title={title ?? label}
      variant={variant}
    >
      {children}
    </Button>
  )
}

export interface RunButtonProps extends Omit<ButtonProps, 'variant' | 'size'> {
  /** Monitoring is running: renders the quiet "stop" appearance. */
  running?: boolean
  /** Mini width: icon only (the label stays as aria-label). */
  compact?: boolean
  label: string
}

/** The large Start/Stop button of the command bar. */
export function RunButton({
  running = false,
  compact = false,
  label,
  loading,
  className,
  children,
  ...rest
}: RunButtonProps): React.JSX.Element {
  return (
    <Button
      {...rest}
      aria-label={compact ? label : undefined}
      className={cx(
        styles['run'],
        running && styles['stop'],
        compact && styles['iconOnly'],
        className,
      )}
      loading={loading}
      title={label}
      variant={running ? 'default' : 'primary'}
    >
      {children}
      {compact ? null : <span>{label}</span>}
    </Button>
  )
}

interface LinkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'default' | 'accent' | 'warn'
}

/** Inline text action ("Управлять ›", "Настроить в профиле"). */
export function LinkButton({
  tone = 'default',
  className,
  type = 'button',
  ...rest
}: LinkButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      className={cx(
        styles['link'],
        tone === 'accent' && styles['linkAccent'],
        tone === 'warn' && styles['linkWarn'],
        className,
      )}
      type={type}
    />
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className={styles['kbd']}>{children}</kbd>
}
