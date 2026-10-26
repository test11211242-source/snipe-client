import type { GameEvent } from '../../../../shared/contracts/game-events'
import type { DeckMode, PickedEvent } from '../../../../shared/models/monitor'
import challengeIcon from '../../ui/assets/modes/challenge.png'
import classicIcon from '../../ui/assets/modes/classic.png'
import elixirIcon from '../../ui/assets/modes/elixir.png'
import grandIcon from '../../ui/assets/modes/grand.png'
import gtIcon from '../../ui/assets/modes/gt.png'
import polIcon from '../../ui/assets/modes/pol.png'
import specialIcon from '../../ui/assets/modes/special.png'
import winsIcon from '../../ui/assets/modes/wins.png'

const NEW_EVENT_MS = 48 * 3600 * 1000

type EventLook = Pick<GameEvent, 'title' | 'kind' | 'max_wins'>

/** The game's own badges (Clash Royale wiki); Path of Legends is the league badge. */
export function modeIcon(mode: DeckMode, event?: EventLook | null): string {
  if (mode === 'pol') return polIcon
  if (mode === 'gt') return gtIcon
  if (event == null) return challengeIcon
  if (/grand/i.test(event.title)) return grandIcon
  if (event.kind === 'challenge')
    return (event.max_wins ?? 0) >= 20 || /\b20\b/.test(event.title)
      ? winsIcon
      : challengeIcon
  if (event.kind === 'classic') return classicIcon
  if (/elixir/i.test(event.title)) return elixirIcon
  return specialIcon
}

export function modeLabel(mode: DeckMode, event?: PickedEvent | null): string {
  if (mode === 'challenge') return event?.title ?? 'Испытание'
  return mode === 'gt' ? 'Турнир' : 'Путь легенд'
}

export function isNew(event: GameEvent, now: number): boolean {
  if (!event.active || event.first_seen_at === null) return false
  const at = Date.parse(event.first_seen_at)
  return Number.isFinite(at) && now - at < NEW_EVENT_MS
}

function losses(count: number): string {
  const last = count % 10
  const teen = count % 100 >= 11 && count % 100 <= 14
  if (last === 1 && !teen) return `${count} поражение`
  if (last >= 2 && last <= 4 && !teen) return `${count} поражения`
  return `${count} поражений`
}

/** «До 12 побед · 3 поражения», or what kind of event it is. */
export function subtitle(event: GameEvent): string {
  if (!event.active) return 'Ивент закончился'
  if (event.max_wins !== null)
    return event.max_losses === null
      ? `До ${event.max_wins} побед`
      : `До ${event.max_wins} побед · ${losses(event.max_losses)}`
  return event.kind === 'classic' ? 'Обычный бой 1 на 1' : 'Особый режим 1 на 1'
}
