import type { MonitorView } from '../../../../shared/models/monitor'
import { GameAccountTagSchema } from '../../../../shared/models/streamer'

export interface SessionOpponent {
  id: string
  name: string
  tag: string
  rating: number | null
  clan: string | null
}

/** Opponents with a tag from the current session history (latest first, unique by tag). */
export function sessionOpponents(view: MonitorView | null): SessionOpponent[] {
  const seen = new Set<string>()
  const list: SessionOpponent[] = []
  for (const result of view?.results ?? []) {
    if (result.kind !== 'player_found' || result.player.tag === null) continue
    const parsed = GameAccountTagSchema.safeParse(result.player.tag)
    if (!parsed.success || seen.has(parsed.data)) continue
    seen.add(parsed.data)
    list.push({
      id: result.id,
      name: result.player.name,
      tag: parsed.data,
      rating: result.player.rating,
      clan: result.player.clan,
    })
  }
  return list
}
