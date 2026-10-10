import { Button, Dialog } from '../../ui'
import { H2HCard } from './H2HCard'
import type { H2HState } from './useH2H'

/** Full «Личные встречи» card as a dialog (opened from the opponent block). */
export function H2HDialog({
  title,
  state,
  onClose,
  onLinkAccount,
  onRetry,
}: {
  title: string
  state: H2HState
  onClose: () => void
  onLinkAccount: () => void
  onRetry: () => void
}): React.JSX.Element {
  return (
    <Dialog
      footer={<Button onClick={onClose}>Закрыть</Button>}
      onClose={onClose}
      title={title}
      wide
    >
      <H2HCard onLinkAccount={onLinkAccount} onRetry={onRetry} state={state} />
    </Dialog>
  )
}
