import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TitleBuilder } from '../../../../shared/contracts/title-builder'
import type { StreamTitleSettings } from '../../../../shared/models/streamer'
import { useStreamer } from './streamerContext'
import { describeCommandError, titleApplicationText } from './text'

/** The part of the title settings the style editor owns (toggles are saved separately). */
type Edits = Partial<StreamTitleSettings>

export interface TitlePreview {
  text: string
  count: number
  warnings: readonly string[]
}

export interface TitleNotice {
  tone: 'ok' | 'warn'
  text: string
}

export interface TitleEditor {
  /** Saved settings with the unsaved edits on top. */
  draft: StreamTitleSettings
  dirty: boolean
  /** Current builder representation of the draft; null until decompiled. */
  builder: TitleBuilder | null
  preview: TitlePreview | null
  previewPending: boolean
  /** Why the last builder change was refused. */
  builderError: string | null
  /** Failure of the last save/apply; the draft is kept. */
  error: string | null
  saving: boolean
  setBuilder: (next: TitleBuilder) => void
  patch: (change: Edits) => void
  discard: () => void
  save: () => Promise<void>
  apply: () => Promise<void>
}

const PREVIEW_DEBOUNCE_MS = 350

/** Settings the chips/preset/raw builder owns; everything else is edited by its own control. */
const BUILDER_KEYS: readonly string[] = [
  'prefixTemplate',
  'includeRank',
  'includeElo',
  'includeWl',
  'includeDelta',
  'accountDisplayMode',
]

/** The entries of `values` that differ from the saved settings. */
function differing(saved: StreamTitleSettings | undefined, values: object): Edits {
  const baseline: Record<string, unknown> = { ...saved }
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => baseline[key] !== value),
  )
}

function without(edits: Edits, keys: readonly string[]): Edits {
  return Object.fromEntries(Object.entries(edits).filter(([key]) => !keys.includes(key)))
}

/**
 * Draft + builder + real server preview of the stream title. Builder changes go through
 * the main-process compile bridge; the preview always comes from the server (`title.preview`)
 * and is requested only when the draft differs from the saved settings.
 */
export function useTitleEditor(onNotice: (notice: TitleNotice) => void): TitleEditor {
  const { view, command } = useStreamer()
  const saved = view?.title.settings
  const [edits, setEdits] = useState<Edits>({})
  const [builder, setBuilderState] = useState<TitleBuilder | null>(null)
  const [preview, setPreview] = useState<TitlePreview | null>(null)
  const [previewPending, setPreviewPending] = useState(false)
  const [builderError, setBuilderError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const compileRun = useRef(0)
  const builderRef = useRef<TitleBuilder | null>(null)
  const showBuilder = useCallback((next: TitleBuilder | null): void => {
    builderRef.current = next
    setBuilderState(next)
  }, [])

  const dirty = Object.keys(edits).length > 0
  const draft = useMemo(
    () => (saved === undefined ? undefined : { ...saved, ...edits }),
    [saved, edits],
  )
  const savedKey = JSON.stringify(saved)
  const draftKey = JSON.stringify(draft)

  // While nothing is edited the builder follows the saved settings (lossless decompile).
  useEffect(() => {
    if (saved === undefined || dirty) return
    let active = true
    const mine = compileRun.current
    void window.crTools.streamer.decompileTitle(saved).then(
      (next) => {
        if (active && mine === compileRun.current) showBuilder(next)
      },
      () => undefined,
    )
    return () => {
      active = false
    }
    // `saved` is represented by savedKey; dirty gates the sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, dirty])

  // Real preview from the server for an edited draft; the saved title uses the view's own.
  useEffect(() => {
    if (!dirty || draft === undefined) return
    let active = true
    const timer = window.setTimeout(() => {
      setPreviewPending(true)
      void command(
        { action: 'title.preview', settings: draft },
        { key: 'title.preview' },
      ).then((outcome) => {
        if (!active || outcome.status === 'superseded') return
        setPreviewPending(false)
        if (outcome.status === 'ok' && outcome.result.preview !== null)
          setPreview({
            text: outcome.result.preview.previewTitle,
            count: outcome.result.preview.characterCount,
            warnings: outcome.result.preview.warnings,
          })
      })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
    // draftKey stands for draft/dirty content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, dirty, command])

  const setBuilder = useCallback(
    (next: TitleBuilder): void => {
      if (draft === undefined) return
      const mine = ++compileRun.current
      const previous = builderRef.current
      // Shown at once so typing in a chip never loses characters; reverted if refused.
      showBuilder(next)
      void window.crTools.streamer.compileTitle({ settings: draft, builder: next }).then(
        (result) => {
          if (mine !== compileRun.current) return
          if (!result.ok) {
            showBuilder(previous)
            setBuilderError(describeCommandError(result.code))
            return
          }
          setBuilderError(null)
          const compiled = result.settings
          const owned = Object.fromEntries(
            Object.entries(compiled).filter(([key]) => BUILDER_KEYS.includes(key)),
          )
          setEdits((current) => ({
            ...without(current, BUILDER_KEYS),
            ...differing(saved, owned),
          }))
        },
        () => {
          if (mine !== compileRun.current) return
          showBuilder(previous)
          setBuilderError(describeCommandError('IPC_FAILED'))
        },
      )
    },
    [draft, saved, showBuilder],
  )

  const patch = useCallback(
    (change: Edits): void => {
      setEdits((current) => ({
        ...without(current, Object.keys(change)),
        ...differing(saved, change),
      }))
    },
    [saved],
  )

  const discard = useCallback((): void => {
    compileRun.current += 1
    setEdits({})
    setBuilderError(null)
    setError(null)
    setPreview(null)
  }, [])

  const submit = useCallback(
    async (action: 'title.save' | 'title.apply'): Promise<void> => {
      if (draft === undefined) return
      setSaving(true)
      setError(null)
      const outcome = await command({ action, settings: draft }, { key: 'title.submit' })
      setSaving(false)
      if (outcome.status === 'failed') {
        setError(describeCommandError(outcome.code))
        return
      }
      if (outcome.status !== 'ok') return
      setEdits({})
      setPreview(null)
      onNotice(
        titleApplicationText(
          outcome.result.titleApplication,
          outcome.result.warnings,
        ) ?? { tone: 'ok', text: 'Сохранено' },
      )
    },
    [command, draft, onNotice],
  )

  return {
    draft: draft as StreamTitleSettings,
    dirty,
    builder,
    preview,
    previewPending,
    builderError,
    error,
    saving,
    setBuilder,
    patch,
    discard,
    save: () => submit('title.save'),
    apply: () => submit('title.apply'),
  }
}
