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
  manualLabel,
  onManual,
}: {
  position: string
  title: string
  lead: string
  actionLabel: string
  backLabel: string | null
  onBack: () => void
  /** Uses the prepared source; resolves with a failure text, or `null` when it worked. */
  onConfirm: (preparation: CapturePreparationResult) => Promise<string | null>
  /** Optional second way on with the same prepared source. */
  manualLabel?: string
  onManual?: (preparation: CapturePreparationResult) => Promise<string | null>
}): React.JSX.Element {
  const picker = useSourcePicker()
  const { take, fail } = picker
  const [acting, setActing] = useState<'primary' | 'secondary' | null>(null)

  const confirm = async (
    kind: 'primary' | 'secondary',
    proceed: (preparation: CapturePreparationResult) => Promise<string | null>,
  ): Promise<void> => {
    const preparation = take()
    if (preparation === null) return
    setActing(kind)
    const failure = await proceed(preparation)
    if (failure !== null) {
      // The preparation is consumed either way; the source has to be picked again.
      fail(failure)
      setActing(null)
    }
  }

  return (
    <SourceStep
      acting={acting !== null}
      actionLabel={actionLabel}
      backLabel={backLabel}
      lead={lead}
      onAction={() => void confirm('primary', onConfirm)}
      onBack={onBack}
      picker={picker}
      position={position}
      secondary={
        manualLabel === undefined || onManual === undefined
          ? undefined
          : {
              label: manualLabel,
              loading: acting === 'secondary',
              onAction: () => void confirm('secondary', onManual),
            }
      }
      title={title}
    />
  )
}
