import {
  EVENT_GONE_MESSAGE,
  GameEventsHttpSchema,
  WebAppSettingsHttpSchema,
  type GameEvent,
} from '../../../shared/contracts/game-events'
import { ApplicationError } from '../../../shared/errors/application-error'
import {
  DeckModeSchema,
  PickedEventSchema,
  type MonitorPreferences,
} from '../../../shared/models/monitor'
import type { AuthenticatedApiClient } from './api-client'

type SettingsHttp = ReturnType<typeof WebAppSettingsHttpSchema.parse>

/** The server's answer as this client's preferences; an unknown mode is Path of Legends. */
export function preferencesFromServer(data: SettingsHttp): MonitorPreferences {
  const mode = DeckModeSchema.safeParse(data.deck_mode)
  const deckMode = mode.success ? mode.data : 'pol'
  if (deckMode !== 'challenge') return { deckMode, event: null }
  const event = PickedEventSchema.safeParse({
    tag: data.event_tag,
    title: data.event_title,
  })
  return { deckMode, event: event.success ? event.data : null }
}

/**
 * One search mode for the site and this client (owner, 26.10.2026): the server keeps it
 * (`/api/webapp/settings`) and searches a challenge scan only in the picked event.
 */
export class DeckModeService {
  constructor(private readonly api: AuthenticatedApiClient) {}

  /** Events in the game now, or null when the server does not answer. */
  async listEvents(): Promise<GameEvent[] | null> {
    const response = await this.api.request({
      method: 'GET',
      path: '/api/webapp/settings/events',
      schema: GameEventsHttpSchema,
      timeoutMs: 10_000,
    })
    return response.ok ? response.data.events : null
  }

  /** The mode the server holds (picked here or on the site), or null when unknown. */
  async read(): Promise<MonitorPreferences | null> {
    const response = await this.api.request({
      method: 'GET',
      path: '/api/webapp/settings',
      schema: WebAppSettingsHttpSchema,
      timeoutMs: 10_000,
    })
    return response.ok ? preferencesFromServer(response.data) : null
  }

  /** Saves the mode on the server; the answer is what the server now holds. */
  async save(preferences: MonitorPreferences): Promise<MonitorPreferences> {
    const event =
      preferences.deckMode === 'challenge' ? (preferences.event ?? null) : null
    const response = await this.api.request({
      method: 'PUT',
      path: '/api/webapp/settings',
      schema: WebAppSettingsHttpSchema,
      body: {
        deck_mode: preferences.deckMode,
        ...(event === null ? {} : { event_tag: event.tag }),
      },
      timeoutMs: 10_000,
    })
    if (!response.ok) {
      const gone = response.error.status === 400 && event !== null
      throw new ApplicationError(
        gone ? 'EVENT_NOT_AVAILABLE' : 'DECK_MODE_SAVE_FAILED',
        gone ? EVENT_GONE_MESSAGE : 'Не удалось сохранить режим',
      )
    }
    return preferencesFromServer(response.data)
  }
}
