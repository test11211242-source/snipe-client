import { useEffect, useState } from 'react'

const PREVIEW_INTERVAL_MS = 1000
const TICK_MS = 250

/**
 * The live picture of the automatic wait: one JPEG about once a second while `active`.
 * Requests never overlap, a failed request just waits for the next tick, and every object
 * URL is revoked when it is replaced or the wait ends.
 */
export function useDetectionPreview(sessionId: string, active: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return undefined
    let stopped = false
    let timer: number | undefined
    let current: string | null = null

    const poll = async (): Promise<void> => {
      try {
        const preview = await window.crTools.setup.getDetectionPreview({ sessionId })
        if (!stopped && preview !== null) {
          const next = URL.createObjectURL(
            new Blob([preview.bytes], { type: preview.mimeType }),
          )
          if (current !== null) URL.revokeObjectURL(current)
          current = next
          setUrl(next)
        }
      } catch {
        /* the wait is over or replaced; the session view says so */
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), PREVIEW_INTERVAL_MS)
    }
    void poll()

    return () => {
      stopped = true
      window.clearTimeout(timer)
      if (current !== null) URL.revokeObjectURL(current)
      setUrl(null)
    }
  }, [sessionId, active])

  return url
}

/**
 * Milliseconds left until `deadlineAt`, derived from the clock rather than from phases: the
 * limit is real, so the countdown is too. The wait screen mounts only while it runs.
 */
export function useRemainingMs(deadlineAt: string): number {
  const deadline = Date.parse(deadlineAt)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  return Math.max(0, deadline - now)
}
