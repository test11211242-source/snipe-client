import { useEffect, useState } from 'react'

import { TITLE_PRESETS } from '../../../../shared/contracts/title-builder'
import { useStreamer } from './streamerContext'

export type PresetId = keyof typeof TITLE_PRESETS
export const PRESET_IDS = Object.keys(TITLE_PRESETS) as PresetId[]

/**
 * Live example of every preset: each preset is compiled on the saved settings and shown
 * with the server preview, so the tiles always use the user's real accounts.
 */
export function useTitleExamples(): Partial<Record<PresetId, string>> {
  const { view, command } = useStreamer()
  const saved = view?.title.settings
  const [examples, setExamples] = useState<Partial<Record<PresetId, string>>>({})
  const key = JSON.stringify({
    saved,
    accounts: view?.title.accounts.map((account) => [
      account.tag,
      account.enabled,
      account.currentRank,
      account.currentElo,
    ]),
    score: view?.title.session,
  })

  useEffect(() => {
    if (saved === undefined) return
    let cancelled = false
    const stopped = (): boolean => cancelled
    const load = async (): Promise<void> => {
      for (const preset of PRESET_IDS) {
        const compiled = await window.crTools.streamer
          .compileTitle({ settings: saved, builder: { mode: 'preset', preset } })
          .catch(() => null)
        if (stopped()) return
        if (compiled?.ok !== true) continue
        const outcome = await command(
          { action: 'title.preview', settings: compiled.settings },
          { key: `title.example.${preset}` },
        )
        if (stopped()) return
        if (outcome.status === 'ok' && outcome.result.preview !== null) {
          const text = outcome.result.preview.previewTitle
          setExamples((current) => ({ ...current, [preset]: text }))
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // The key captures everything the examples depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, command])

  return examples
}
