import { useCallback, useRef, useState } from 'react'

import type { StreamerCommand } from '../../../../shared/contracts/streamer-ipc'
import { useToast } from '../../ui'
import { useStreamer } from './streamerContext'
import { describeCommandError } from './text'
import type { CommandOptions, CommandOutcome } from './useStreamerController'

export interface Runner {
  /** Latest failure of a command started through this runner; cleared by the next run. */
  error: string | null
  clearError: () => void
  /** Runs a command; reports failures through `error`. Successes are the caller's to word. */
  run: (command: StreamerCommand, options?: CommandOptions) => Promise<CommandOutcome>
}

/** Page-level wrapper around `streamer.command` that keeps one visible error line. */
export function useRunner(): Runner {
  const { command } = useStreamer()
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(
    async (next: StreamerCommand, options?: CommandOptions): Promise<CommandOutcome> => {
      setError(null)
      const outcome = await command(next, options)
      if (outcome.status === 'failed') setError(describeCommandError(outcome.code))
      return outcome
    },
    [command],
  )
  return { error, clearError: () => setError(null), run }
}

export interface ConfirmedAction {
  open: boolean
  pending: boolean
  error: string | null
  ask: () => void
  cancel: () => void
  confirm: () => void
}

/**
 * A destructive command behind a confirmation dialog. The dialog stays open with the real
 * error on failure and only closes after the command really succeeded.
 */
export function useConfirmedAction(
  command: StreamerCommand,
  onDone?: (outcome: Extract<CommandOutcome, { status: 'ok' }>) => void,
): ConfirmedAction {
  const { command: send } = useStreamer()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const confirm = (): void => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(null)
    void send(command).then((outcome) => {
      busy.current = false
      setPending(false)
      if (outcome.status === 'ok') {
        setOpen(false)
        onDone?.(outcome)
      } else if (outcome.status === 'failed') {
        setError(describeCommandError(outcome.code))
      }
    })
  }
  return {
    open,
    pending,
    error,
    ask: () => {
      setError(null)
      setOpen(true)
    },
    cancel: () => {
      if (!busy.current) setOpen(false)
    },
    confirm,
  }
}

/** Toast helper for successful non-title commands. */
export function useSuccessToast(): (message: string) => void {
  const toast = useToast()
  return useCallback((message: string) => toast.show({ message }), [toast])
}
