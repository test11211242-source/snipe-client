import { useState } from 'react'

import type { CapturePreparationResult } from '../../../../shared/contracts/capture-ipc'
import { SourceStep } from './EntrySteps'
import { useSourcePicker } from './useSourcePicker'

/**
 * Source step with its own picker: windows and screens are listed only while this step is
 * open, and the prepared source is released when it closes without being used.
 */
export function SourceStage({
  position,
  title,
  lead,
  actionLabel,
  backLabel,
  onBack,
  onConfirm,
}: {
  position: string
  title: string
  lead: string
  actionLabel: string
  backLabel: string | null
  onBack: () => void
  /** Uses the prepared source; resolves with a failure text, or `null` when it worked. */
  onConfirm: (preparation: CapturePreparationResult) => Promise<string | null>
}): React.JSX.Element {
  const picker = useSourcePicker()
  const { take, fail } = picker
  const [acting, setActing] = useState(false)

  const confirm = async (): Promise<void> => {
    const preparation = take()
    if (preparation === null) return
    setActing(true)
    const failure = await onConfirm(preparation)
    if (failure !== null) {
      // The preparation is consumed either way; the source has to be picked again.
      fail(failure)
      setActing(false)
    }
  }

  return (
    <SourceStep
      acting={acting}
      actionLabel={actionLabel}
      backLabel={backLabel}
      lead={lead}
      onAction={() => void confirm()}
      onBack={onBack}
      picker={picker}
      position={position}
      title={title}
    />
  )
}
