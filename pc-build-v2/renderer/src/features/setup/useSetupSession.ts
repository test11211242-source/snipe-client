import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SetupCommand } from '../../../../shared/contracts/capture-ipc'
import type { NormalizedRect, RegionKind } from '../../../../shared/models/capture'
import type { SetupSessionView } from '../../../../shared/models/setup'
import { commandErrorMessage, isStaleCause, viewErrorMessage } from './errors'

const FINAL = ['COMMITTED', 'CANCELLED', 'FAILED'] as const
const TRANSIENT = ['CREATED', 'CAPTURING', 'SAVING'] as const

const STEP_FAILED = 'Не удалось выполнить шаг. Проверьте области и повторите.'

export const isFinalState = (state: SetupSessionView['state']): boolean =>
  (FINAL as readonly string[]).includes(state)

const command = (view: SetupSessionView): SetupCommand => ({
  sessionId: view.sessionId,
  generation: view.generation,
})

const STALE_TEXT = 'Состояние настройки изменилось. Мы его обновили — повторите шаг.'

export interface SetupSession {
  view: SetupSessionView | null
  /** Object URL of the frozen frame of the current session. */
  frameUrl: string | null
  /** The frame could not be loaded for the current session. */
  frameFailed: boolean
  /** A command is in flight; commands never overlap. */
  busy: boolean
  /** Renderer-side failure text, or the text of main's error on the view. */
  error: string | null
  /** Latest accepted view; valid right after an awaited command. */
  latest: () => SetupSessionView | null
  /** Takes over a session main already has (new start or resumed) and loads its frame. */
  adopt: (view: SetupSessionView) => Promise<void>
  /** Asks main for the current session and adopts it unless it is finished. */
  resume: () => Promise<SetupSessionView | null>
  refresh: () => Promise<void>
  retryFrame: () => Promise<void>
  setRegion: (
    region: RegionKind,
    rect: NormalizedRect,
  ) => Promise<SetupSessionView | null>
  analyze: () => Promise<SetupSessionView | null>
  review: () => Promise<SetupSessionView | null>
  commit: () => Promise<SetupSessionView | null>
  retrySync: () => Promise<SetupSessionView | null>
  /** Cancels or closes the session. `true` when it is over (or already gone). */
  end: () => Promise<boolean>
  clearError: () => void
}

/**
 * The renderer's side of one main-process setup session. Every command carries the
 * session ID and generation it was issued for; a reply for another session, or one that
 * does not advance the generation, is rejected as stale and the session is reloaded.
 * Commands are serialized: while one is in flight the others do nothing.
 */
export function useSetupSession(): SetupSession {
  const [view, setView] = useState<SetupSessionView | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameFailed, setFrameFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  // What to say when main reports an error code the UI has no wording for.
  const [stepFallback, setStepFallback] = useState(STEP_FAILED)
  const viewRef = useRef<SetupSessionView | null>(null)
  const frameRef = useRef<{ sessionId: string; url: string } | null>(null)
  const busyRef = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (frameRef.current !== null) URL.revokeObjectURL(frameRef.current.url)
      frameRef.current = null
    }
  }, [])

  const dropFrame = useCallback((): void => {
    if (frameRef.current !== null) URL.revokeObjectURL(frameRef.current.url)
    frameRef.current = null
    setFrameUrl(null)
  }, [])

  const loadFrame = useCallback(
    async (next: SetupSessionView): Promise<void> => {
      if (next.frameSize === null || isFinalState(next.state)) {
        if (frameRef.current !== null) dropFrame()
        setFrameFailed(false)
        return
      }
      if (frameRef.current?.sessionId === next.sessionId) return
      try {
        const frame = await window.crTools.setup.getFrame(command(next))
        if (frame.sessionId !== next.sessionId || frame.generation !== next.generation)
          throw new Error('Setup frame does not belong to the active session')
        const url = URL.createObjectURL(new Blob([frame.bytes], { type: frame.mimeType }))
        if (!alive.current || viewRef.current?.sessionId !== next.sessionId) {
          URL.revokeObjectURL(url)
          return
        }
        if (frameRef.current !== null) URL.revokeObjectURL(frameRef.current.url)
        frameRef.current = { sessionId: next.sessionId, url }
        setFrameUrl(url)
        setFrameFailed(false)
      } catch {
        if (alive.current && viewRef.current?.sessionId === next.sessionId)
          setFrameFailed(true)
      }
    },
    [dropFrame],
  )

  const accept = useCallback(
    async (next: SetupSessionView): Promise<void> => {
      const previous = viewRef.current
      if (previous !== null && previous.sessionId !== next.sessionId) dropFrame()
      viewRef.current = next
      setView(next)
      await loadFrame(next)
    },
    [dropFrame, loadFrame],
  )

  const adopt = useCallback(
    async (next: SetupSessionView): Promise<void> => {
      setCommandError(null)
      await accept(next)
    },
    [accept],
  )

  const resume = useCallback(async (): Promise<SetupSessionView | null> => {
    try {
      const current = await window.crTools.setup.getSession()
      if (!alive.current || isFinalState(current.state)) return null
      await accept(current)
      return current
    } catch {
      return null
    }
  }, [accept])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const current = await window.crTools.setup.getSession()
      if (alive.current) await accept(current)
    } catch {
      /* the session is gone; the next command reports it */
    }
  }, [accept])

  const retryFrame = useCallback(async (): Promise<void> => {
    const current = viewRef.current
    if (current === null) return
    setFrameFailed(false)
    await refresh()
  }, [refresh])

  const run = useCallback(
    async (
      invoke: (request: SetupCommand) => Promise<SetupSessionView>,
      failure: string,
      viewFailure: string = STEP_FAILED,
    ): Promise<SetupSessionView | null> => {
      const current = viewRef.current
      if (current === null || busyRef.current) return null
      busyRef.current = true
      setBusy(true)
      setCommandError(null)
      setStepFallback(viewFailure)
      const request = command(current)
      try {
        const next = await invoke(request)
        const latest = viewRef.current
        if (
          !alive.current ||
          latest?.sessionId !== request.sessionId ||
          latest.generation !== request.generation ||
          next.sessionId !== request.sessionId ||
          next.generation <= request.generation
        ) {
          if (alive.current) {
            setCommandError(STALE_TEXT)
            void refresh()
          }
          return null
        }
        await accept(next)
        return next
      } catch (cause) {
        if (alive.current) {
          setCommandError(commandErrorMessage(cause, failure))
          if (isStaleCause(cause)) void refresh()
        }
        return null
      } finally {
        busyRef.current = false
        if (alive.current) setBusy(false)
      }
    },
    [accept, refresh],
  )

  const setRegion = useCallback(
    (region: RegionKind, rect: NormalizedRect) =>
      run(
        (request) => window.crTools.setup.setRegion({ ...request, region, rect }),
        'Не удалось сохранить область. Проверьте её и повторите.',
      ),
    [run],
  )
  const analyze = useCallback(
    () =>
      run(
        (request) => window.crTools.setup.analyzeTrigger(request),
        'Не удалось проверить триггер. Повторите.',
        'Не удалось найти устойчивую структуру. Выберите область триггера вместе с рамкой или окружающим интерфейсом.',
      ),
    [run],
  )
  const review = useCallback(
    () =>
      run(
        (request) => window.crTools.setup.review(request),
        'Не удалось подготовить сохранение. Повторите.',
      ),
    [run],
  )
  const commit = useCallback(
    () =>
      run(
        (request) => window.crTools.setup.commit(request),
        'Не удалось подтвердить сохранение. Повторите.',
      ),
    [run],
  )
  const retrySync = useCallback(
    () =>
      run(
        (request) => window.crTools.setup.retrySync(request),
        'Не удалось отправить настройку на сервер. Повторите.',
      ),
    [run],
  )

  const end = useCallback(async (): Promise<boolean> => {
    const current = viewRef.current
    if (current === null) return true
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setCommandError(null)
    try {
      const request = command(current)
      if (isFinalState(current.state)) await window.crTools.setup.close(request)
      else await window.crTools.setup.cancel(request)
      return true
    } catch (cause) {
      // A session that is already over (or replaced) is not a reason to keep the user here.
      try {
        const latest = await window.crTools.setup.getSession()
        if (latest.sessionId !== current.sessionId || isFinalState(latest.state))
          return true
      } catch {
        return true
      }
      if (alive.current)
        setCommandError(
          commandErrorMessage(cause, 'Не удалось закрыть настройку. Повторите попытку.'),
        )
      return false
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }, [])

  // States main moves out of on its own (frame capture, saving): follow them.
  const transient = view !== null && (TRANSIENT as readonly string[]).includes(view.state)
  useEffect(() => {
    if (!transient) return undefined
    const timer = setInterval(() => {
      if (!busyRef.current) void refresh()
    }, 800)
    return () => clearInterval(timer)
  }, [transient, refresh])

  const latest = useCallback(() => viewRef.current, [])
  const clearError = useCallback(() => setCommandError(null), [])
  const error =
    commandError ??
    (view?.error == null ? null : (viewErrorMessage(view.error) ?? stepFallback))

  return useMemo(
    () => ({
      view,
      frameUrl,
      frameFailed,
      busy,
      error,
      latest,
      adopt,
      resume,
      refresh,
      retryFrame,
      setRegion,
      analyze,
      review,
      commit,
      retrySync,
      end,
      clearError,
    }),
    [
      view,
      frameUrl,
      frameFailed,
      busy,
      error,
      latest,
      adopt,
      resume,
      refresh,
      retryFrame,
      setRegion,
      analyze,
      review,
      commit,
      retrySync,
      end,
      clearError,
    ],
  )
}
