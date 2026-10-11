import type { CSSProperties, ReactNode } from 'react'

import { cx } from './cx'
import styles from './Feedback.module.css'
import { Icon, type IconName } from './Icon'

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info'

const toneClass = (tone: Tone): string | false | undefined =>
  tone !== 'neutral' && styles[tone]

/** Status text pill. Text always carries the state, colour only reinforces it. */
export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: Tone
  children: ReactNode
}): React.JSX.Element {
  return <span className={cx(styles['pill'], toneClass(tone))}>{children}</span>
}

const dotClass: Record<Tone, string | false | undefined> = {
  neutral: false,
  info: false,
  ok: styles['dotOk'],
  warn: styles['dotWarn'],
  danger: styles['dotDanger'],
}

/** Decorative status dot (pair with text). `live` pulses. */
export function Dot({
  tone = 'neutral',
  live = false,
}: {
  tone?: Tone
  live?: boolean
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cx(styles['dot'], dotClass[tone], live && styles['live'])}
    />
  )
}

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <span
      aria-label={label}
      aria-hidden={label === undefined ? 'true' : undefined}
      className={styles['spinner']}
      role={label === undefined ? undefined : 'status'}
    />
  )
}

/** Placeholder with the shape of the awaited content. */
export function Skeleton({
  width,
  height,
  className,
}: {
  width?: number | string
  height?: number | string
  className?: string
}): React.JSX.Element {
  const style: CSSProperties = { width, height }
  return (
    <span
      aria-hidden="true"
      className={cx(styles['skeleton'], className)}
      style={style}
    />
  )
}

export function Progress({
  value,
  label,
  tone = 'ok',
}: {
  /** 0–100. */
  value: number
  label: string
  tone?: 'ok' | 'warn'
}): React.JSX.Element {
  const percent = Math.max(0, Math.min(100, value))
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(percent)}
      className={cx(styles['progress'], tone === 'warn' && styles['progressWarn'])}
      role="progressbar"
    >
      <i style={{ width: `${percent}%` }} />
    </div>
  )
}

/** Round user marker with the first letter of the name. */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}): React.JSX.Element {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?'
  return (
    <span
      aria-hidden="true"
      className={cx(
        styles['avatar'],
        size === 'sm' && styles['avatarSm'],
        size === 'lg' && styles['avatarLg'],
        className,
      )}
    >
      {initial}
    </span>
  )
}

export interface BannerProps {
  tone?: Exclude<Tone, 'info'>
  icon?: IconName
  title: string
  children?: ReactNode
  /** Right-aligned actions or a spinner. */
  actions?: ReactNode
  /** Announced politely when it appears (default true). */
  live?: boolean
}

/** Longer-lived message: title, one line of explanation and optional actions. */
export function Banner({
  tone = 'neutral',
  icon = 'info',
  title,
  children,
  actions,
  live = true,
}: BannerProps): React.JSX.Element {
  return (
    <div
      className={cx(styles['banner'], toneClass(tone))}
      role={live ? 'status' : undefined}
    >
      <span className={styles['bannerIc']}>
        <Icon name={icon} size={15} />
      </span>
      <div className={styles['bannerText']}>
        <b>{title}</b>
        {children === undefined ? null : <span>{children}</span>}
      </div>
      {actions === undefined ? null : (
        <div className={styles['bannerActions']}>{actions}</div>
      )}
    </div>
  )
}

export interface StateProps {
  tone?: Exclude<Tone, 'info'>
  icon: IconName
  title: string
  children?: ReactNode
  /** Up to two actions. */
  actions?: ReactNode
  meta?: ReactNode
  /** Expanding rings: calm waiting. */
  pulse?: boolean
  headingLevel?: 2 | 3
}

/** Empty / loading / error / waiting block: icon · title · one sentence · actions · meta. */
export function State({
  tone = 'neutral',
  icon,
  title,
  children,
  actions,
  meta,
  pulse = false,
  headingLevel = 2,
}: StateProps): React.JSX.Element {
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <div className={styles['state']}>
      <span
        className={cx(styles['stateIcon'], toneClass(tone), pulse && styles['pulse'])}
      >
        <Icon name={icon} size={22} />
      </span>
      <Heading className={styles['stateTitle']}>{title}</Heading>
      {children === undefined ? null : <p className={styles['stateText']}>{children}</p>}
      {actions === undefined ? null : (
        <div className={styles['stateActions']}>{actions}</div>
      )}
      {meta === undefined ? null : <span className={styles['stateMeta']}>{meta}</span>}
    </div>
  )
}
