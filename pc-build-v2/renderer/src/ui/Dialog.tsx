import { useId, useRef, type SyntheticEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { Button, IconButton } from './Button'
import { cx } from './cx'
import { useModalFocus } from './focus'
import { Banner } from './Feedback'
import { Icon } from './Icon'
import styles from './Dialog.module.css'

export interface DialogProps {
  title: string
  /** Esc, the scrim and the cancel button call this. */
  onClose: () => void
  children?: ReactNode
  /** Footer buttons, cancel first. */
  footer: ReactNode
  /** "alertdialog" for confirmations of destructive actions. */
  role?: 'dialog' | 'alertdialog'
  /** Short explanatory sentence under the title. */
  description?: ReactNode
}

/** Modal dialog: focus trap, Esc, focus returns to the opener. Rendered into body. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  role = 'dialog',
  description,
}: DialogProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const textId = useId()
  useModalFocus(ref, onClose)
  return createPortal(
    <div
      className={styles['scrim']}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        aria-describedby={description === undefined ? undefined : textId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles['dialog']}
        ref={ref}
        role={role}
        tabIndex={-1}
      >
        <div className={styles['body']}>
          <h2 className={styles['title']} id={titleId}>
            {title}
          </h2>
          {description === undefined ? null : (
            <p className={styles['text']} id={textId}>
              {description}
            </p>
          )}
          {children}
        </div>
        <div className={styles['foot']}>{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

/** Bulleted notes inside dialogs ("Что нового"). */
export function DialogNotes({ items }: { items: readonly string[] }): React.JSX.Element {
  return (
    <ul className={styles['notes']}>
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>{item}</li>
      ))}
    </ul>
  )
}

export interface ConfirmDialogProps {
  title: string
  /** What will happen and what stays. */
  text: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  /** The action is running: the button shows a spinner and cancel is blocked. */
  pending?: boolean
  /** Failure of the real action; the dialog stays open. */
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
}

/** "Заголовок-вопрос · что произойдёт · Отмена + глагол". Never reports success itself. */
export function ConfirmDialog({
  title,
  text,
  confirmLabel,
  cancelLabel = 'Отмена',
  tone = 'danger',
  pending = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog
      description={text}
      footer={
        <>
          <Button disabled={pending} onClick={onCancel} variant="ghost">
            {cancelLabel}
          </Button>
          <Button
            loading={pending}
            onClick={onConfirm}
            variant={tone === 'danger' ? 'dangerSolid' : 'primary'}
          >
            {confirmLabel}
          </Button>
        </>
      }
      onClose={() => {
        if (!pending) onCancel()
      }}
      role="alertdialog"
      title={title}
    >
      {children}
      {error === null ? null : (
        <Banner icon="alert" live title="Не получилось" tone="danger">
          {error}
        </Banner>
      )}
    </Dialog>
  )
}

export interface PanelProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/** Right side panel (profiles): scrim, Esc/click-outside close, focus trap. */
export function Panel({
  title,
  onClose,
  children,
  footer,
}: PanelProps): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const titleId = useId()
  useModalFocus(ref, onClose)
  return createPortal(
    <>
      <div className={styles['panelShade']} onPointerDown={onClose} />
      <aside
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles['panel']}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles['panelHead']}>
          <h2 className={styles['panelTitle']} id={titleId}>
            {title}
          </h2>
          <IconButton label="Закрыть" onClick={onClose}>
            <Icon name="close" size={16} />
          </IconButton>
        </div>
        <div className={styles['panelBody']}>{children}</div>
        {footer === undefined ? null : (
          <div className={styles['panelFoot']}>{footer}</div>
        )}
      </aside>
    </>,
    document.body,
  )
}

export interface PaletteProps {
  /** Accessible name of the dialog and the input. */
  label: string
  placeholder: string
  value: string
  onValueChange: (next: string) => void
  onSubmit: () => void
  onClose: () => void
  children?: ReactNode
  hint?: ReactNode
}

/** Command-palette shell (Ctrl+K "Проверить тег"): input on top, free body, hint line. */
export function Palette({
  label,
  placeholder,
  value,
  onValueChange,
  onSubmit,
  onClose,
  children,
  hint,
}: PaletteProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useModalFocus(ref, onClose, input)
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault()
    onSubmit()
  }
  return createPortal(
    <div
      className={cx(styles['scrim'], styles['top'])}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        aria-label={label}
        aria-modal="true"
        className={styles['palette']}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <form className={styles['paletteIn']} onSubmit={submit}>
          <Icon name="search" size={18} />
          <input
            aria-label={label}
            autoComplete="off"
            className={styles['paletteInput']}
            onChange={(event) => onValueChange(event.currentTarget.value)}
            placeholder={placeholder}
            ref={input}
            spellCheck={false}
            value={value}
          />
        </form>
        <div className={styles['paletteBody']}>{children}</div>
        {hint === undefined ? null : <div className={styles['paletteHint']}>{hint}</div>}
      </div>
    </div>,
    document.body,
  )
}
