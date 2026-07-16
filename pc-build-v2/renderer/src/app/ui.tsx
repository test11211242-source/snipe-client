import {
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'text' | 'icon'

export function Button({
  variant = 'secondary',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}): React.JSX.Element {
  const variantClass = variant === 'icon' ? 'icon-button' : `${variant}-button`
  return (
    <button
      className={[variantClass, className].filter(Boolean).join(' ')}
      type="button"
      {...props}
    >
      {children}
    </button>
  )
}

export interface TabOption<T extends string> {
  id: T
  label: string
  count?: number
}

export function Tabs<T extends string>({
  id,
  label,
  tabs,
  value,
  onChange,
  className,
}: {
  id: string
  label: string
  tabs: readonly TabOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}): React.JSX.Element {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const selectAt = (index: number): void => {
    const next = tabs[index]
    if (next === undefined) return
    onChange(next.id)
    tabRefs.current[index]?.focus()
  }

  return (
    <div
      className={['tabs', className].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab, index) => (
        <button
          aria-controls={`${id}-panel-${tab.id}`}
          aria-selected={value === tab.id}
          id={`${id}-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            let nextIndex: number | null = null
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
            if (event.key === 'ArrowLeft')
              nextIndex = (index - 1 + tabs.length) % tabs.length
            if (event.key === 'Home') nextIndex = 0
            if (event.key === 'End') nextIndex = tabs.length - 1
            if (nextIndex === null) return
            event.preventDefault()
            selectAt(nextIndex)
          }}
          ref={(node) => {
            tabRefs.current[index] = node
          }}
          role="tab"
          tabIndex={value === tab.id ? 0 : -1}
          type="button"
        >
          {tab.label}
          {tab.count !== undefined && <span aria-hidden="true">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  label,
  detail,
  checked,
  disabled = false,
  onChange,
  className,
}: {
  label: string
  detail?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  className?: string
}): React.JSX.Element {
  return (
    <label className={['ui-toggle', className].filter(Boolean).join(' ')}>
      <span className="ui-toggle-copy">
        <strong>{label}</strong>
        {detail !== undefined && <small>{detail}</small>}
      </span>
      <span className="switch-control">
        <input
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span aria-hidden="true" />
      </span>
    </label>
  )
}

export function Status({
  label,
  value,
  tone = 'neutral',
  live = false,
}: {
  label: string
  value?: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'loading'
  live?: boolean
}): React.JSX.Element {
  return (
    <span className="ui-status" data-tone={tone} aria-live={live ? 'polite' : undefined}>
      <i aria-hidden="true" />
      <span>{label}</span>
      {value !== undefined && <strong>{value}</strong>}
    </span>
  )
}

export function Alert({
  title,
  children,
  tone = 'danger',
  details,
}: {
  title?: string
  children: ReactNode
  tone?: 'danger' | 'warning' | 'info' | 'success'
  details?: ReactNode
}): React.JSX.Element {
  return (
    <div
      className="ui-alert"
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <div>
        {title !== undefined && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
      {details !== undefined && (
        <details>
          <summary>Технические подробности</summary>
          {details}
        </details>
      )}
    </div>
  )
}

export function AsyncState({
  title,
  detail,
  loading = false,
  action,
}: {
  title: string
  detail: string
  loading?: boolean
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="async-state" aria-busy={loading} aria-live="polite" role="status">
      <span className="async-state-mark" data-loading={loading} aria-hidden="true" />
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  headingId,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
  headingId?: string
}): React.JSX.Element {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2 id={headingId}>{title}</h2>
        <p>{description}</p>
      </div>
      {actions !== undefined && <div className="page-header-actions">{actions}</div>}
    </header>
  )
}

export function Section({
  title,
  eyebrow,
  actions,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  title: string
  eyebrow?: string
  actions?: ReactNode
}): React.JSX.Element {
  const generatedId = useId()
  const headingId = `${generatedId}-heading`
  return (
    <section
      className={['ui-section', className].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
      {...props}
    >
      <div className="section-heading">
        <div>
          {eyebrow !== undefined && <span className="eyebrow">{eyebrow}</span>}
          <h2 id={headingId}>{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}
