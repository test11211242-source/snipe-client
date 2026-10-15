import { useCallback, useEffect, useRef, useState } from 'react'

import type { CapturePreparationResult } from '../../../../shared/contracts/capture-ipc'
import type {
  CaptureSourceSnapshot,
  CaptureSourceView,
} from '../../../../shared/models/capture'
import { preparationFailureMessage } from './errors'

export type SourceTab = 'window' | 'display'

const LIST_FAILED = 'Не удалось получить источники. Захват доступен только в Windows.'

export interface SourcePicker {
  /** Sources of the current tab. */
  sources: readonly CaptureSourceView[]
  counts: Record<SourceTab, number>
  tab: SourceTab
  setTab: (tab: SourceTab) => void
  loading: boolean
  /** The picked source finished preparing and can be frozen. */
  preparation: CapturePreparationResult | null
  selectedKey: string | null
  /** Source key being prepared right now. */
  preparingKey: string | null
  error: string | null
  refresh: () => Promise<boolean>
  select: (source: CaptureSourceView) => Promise<void>
  /** Gives the prepared source up (kept alive by main for ~30 s otherwise). */
  release: () => void
  /** Hands the preparation to `startCaptureSetup`, which consumes it. */
  take: () => CapturePreparationResult | null
  /** Show an error from outside (e.g. freezing the frame failed). */
  fail: (message: string) => void
}

/**
 * Real capture sources: list, previews, and preparation of the picked source. A source is
 * prepared as soon as it is picked; a failure from a superseded pick is ignored, and a
 * genuinely stale source reloads the list.
 */
export function useSourcePicker(): SourcePicker {
  const [snapshot, setSnapshot] = useState<CaptureSourceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTabState] = useState<SourceTab>('window')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [preparation, setPreparation] = useState<CapturePreparationResult | null>(null)
  const [preparingKey, setPreparingKey] = useState<string | null>(null)
  const listGeneration = useRef(0)
  const selectionGeneration = useRef(0)
  const selected = useRef<CaptureSourceView | null>(null)
  const preparedRef = useRef<CapturePreparationResult | null>(null)

  const release = useCallback((): void => {
    selectionGeneration.current += 1
    const source = selected.current
    selected.current = null
    preparedRef.current = null
    setSelectedKey(null)
    setPreparation(null)
    setPreparingKey(null)
    if (source !== null)
      void window.crTools
        .releaseCaptureSource({ sourceKey: source.sourceKey, revision: source.revision })
        .catch(() => undefined)
  }, [])

  useEffect(() => {
    const generation = ++listGeneration.current
    void window.crTools
      .listCaptureSources()
      .then(
        (value) => {
          if (generation === listGeneration.current) setSnapshot(value)
        },
        () => {
          if (generation === listGeneration.current) setError(LIST_FAILED)
        },
      )
      .finally(() => {
        if (generation === listGeneration.current) setLoading(false)
      })
    return () => {
      listGeneration.current += 1
      selectionGeneration.current += 1
      const source = selected.current
      selected.current = null
      if (source !== null)
        void window.crTools
          .releaseCaptureSource({
            sourceKey: source.sourceKey,
            revision: source.revision,
          })
          .catch(() => undefined)
    }
  }, [])

  const revision = snapshot?.revision
  useEffect(() => {
    if (revision === undefined) return undefined
    let active = true
    // Main answers as soon as newer previews exist; keep asking while it reports more.
    const load = async (): Promise<void> => {
      for (let response = 0; response < 300; response += 1) {
        const next = await window.crTools.loadCapturePreviews({ revision })
        if (!active) return
        setSnapshot((current) => (current?.revision === next.revision ? next : current))
        if (next.previewsPending !== true) return
      }
    }
    void load().catch(() => undefined)
    return () => {
      active = false
    }
  }, [revision])

  const refresh = useCallback(async (): Promise<boolean> => {
    const generation = ++listGeneration.current
    release()
    setLoading(true)
    setError(null)
    try {
      const value = await window.crTools.listCaptureSources()
      if (generation !== listGeneration.current) return false
      setSnapshot(value)
      return true
    } catch {
      if (generation === listGeneration.current) setError(LIST_FAILED)
      return false
    } finally {
      if (generation === listGeneration.current) setLoading(false)
    }
  }, [release])

  const select = useCallback(
    async (source: CaptureSourceView): Promise<void> => {
      if (!source.captureSupported) return
      if (
        selected.current?.sourceKey === source.sourceKey &&
        selected.current.revision === source.revision
      )
        return
      const previous = selected.current
      const generation = ++selectionGeneration.current
      if (previous !== null && previous.sourceKey !== source.sourceKey)
        void window.crTools
          .releaseCaptureSource({
            sourceKey: previous.sourceKey,
            revision: previous.revision,
          })
          .catch(() => undefined)
      selected.current = source
      setSelectedKey(source.sourceKey)
      setPreparation(null)
      preparedRef.current = null
      setPreparingKey(source.sourceKey)
      setError(null)
      const stillPicked = (): boolean => selected.current?.sourceKey === source.sourceKey
      try {
        const response = await window.crTools.prepareCaptureSource({
          sourceKey: source.sourceKey,
          revision: source.revision,
        })
        if (generation !== selectionGeneration.current || !stillPicked()) return
        if (!response.ok) {
          if (response.error.code === 'CAPTURE_SOURCE_STALE') {
            selected.current = null
            setSelectedKey(null)
            if (await refresh())
              setError(
                'Источник изменился. Список обновлён, выберите нужный источник ещё раз.',
              )
          } else {
            selected.current = null
            setSelectedKey(null)
            setError(preparationFailureMessage(response.error.code))
          }
          return
        }
        preparedRef.current = response.preparation
        setPreparation(response.preparation)
      } catch {
        if (generation !== selectionGeneration.current) return
        selected.current = null
        setSelectedKey(null)
        setError('Не удалось подготовить выбранный источник. Выберите его повторно.')
      } finally {
        if (generation === selectionGeneration.current) setPreparingKey(null)
      }
    },
    [refresh],
  )

  const setTab = useCallback(
    (next: SourceTab): void => {
      if (next === tab) return
      release()
      setTabState(next)
    },
    [release, tab],
  )

  const take = useCallback((): CapturePreparationResult | null => {
    const prepared = preparedRef.current
    if (prepared === null) return null
    // Freezing consumes the preparation; do not release it afterwards.
    selected.current = null
    preparedRef.current = null
    selectionGeneration.current += 1
    setSelectedKey(null)
    setPreparation(null)
    return prepared
  }, [])

  const all = snapshot?.sources ?? []
  const counts: Record<SourceTab, number> = {
    window: all.filter((source) => source.kind === 'window').length,
    display: all.filter((source) => source.kind === 'display').length,
  }

  return {
    sources: all.filter((source) => source.kind === tab),
    counts,
    tab,
    setTab,
    loading,
    preparation,
    selectedKey,
    preparingKey,
    error,
    refresh,
    select,
    release,
    take,
    fail: setError,
  }
}
