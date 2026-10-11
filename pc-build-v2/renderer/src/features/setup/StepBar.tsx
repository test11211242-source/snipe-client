import { Button, Icon, cx } from '../../ui'
import styles from './Setup.module.css'

/**
 * Top bar of the setup route: cancel, the steps, and the monitoring note. Setup has no
 * command bar; this is the only chrome.
 */
export function StepBar({
  steps,
  index,
  onCancel,
  cancelLabel = 'Отмена',
  cancelDisabled,
  note,
}: {
  steps: readonly string[]
  /** Zero-based current step; `steps.length` means all done. */
  index: number
  onCancel: () => void
  cancelLabel?: string
  cancelDisabled: boolean
  note: string | null
}): React.JSX.Element {
  return (
    <header className={styles['top']}>
      <div>
        <Button disabled={cancelDisabled} onClick={onCancel} variant="ghost">
          <Icon name="close" size={15} />
          {cancelLabel}
        </Button>
      </div>
      <ol aria-label="Этапы настройки" className={styles['stepper']}>
        {steps.flatMap((label, position) => {
          const done = position < index
          const current = position === index
          const item = (
            <li
              aria-current={current ? 'step' : undefined}
              className={cx(
                styles['step'],
                done && styles['stepDone'],
                current && styles['stepOn'],
              )}
              key={label}
            >
              <span aria-hidden="true" className={styles['stepMark']}>
                {done ? <Icon name="check" size={11} /> : position + 1}
              </span>
              <span className={styles['stepLabel']}>{label}</span>
            </li>
          )
          return position === 0
            ? [item]
            : [
                <li
                  aria-hidden="true"
                  className={styles['stepSep']}
                  key={`sep-${label}`}
                />,
                item,
              ]
        })}
      </ol>
      <div className={styles['topRight']}>{note}</div>
    </header>
  )
}
