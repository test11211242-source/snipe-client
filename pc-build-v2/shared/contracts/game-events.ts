import { z } from 'zod'

import { MonitorPreferencesSchema } from '../models/monitor'

/**
 * Live Clash Royale events the server lists for the mode picker
 * (`GET /api/webapp/settings/events`, Supercell `/events` behind it). The site and this
 * client share one search mode: `GET/PUT /api/webapp/settings`.
 */
export const GameEventSchema = z.object({
  tag: z.string().regex(/^#[0-9A-Z]{3,15}$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(1000).nullable().default(null),
  kind: z.string().max(40),
  max_wins: z.number().int().min(0).max(1000).nullable().default(null),
  max_losses: z.number().int().min(0).max(1000).nullable().default(null),
  /** When the event appeared; null when it was there before the server started watching. */
  first_seen_at: z.string().max(40).nullable().default(null),
  active: z.boolean(),
})

export const GameEventsHttpSchema = z.object({
  events: z.array(GameEventSchema).max(50),
})

export const WebAppSettingsHttpSchema = z.object({
  deck_mode: z.string().max(20),
  event_tag: z.string().max(20).nullable().optional(),
  event_title: z.string().max(200).nullable().optional(),
})

/** What the picker shows: the live events and the mode the server holds now. */
export const ModeOptionsSchema = z
  .object({
    /** Null when the list could not be loaded. */
    events: z.array(GameEventSchema).max(50).nullable(),
    preferences: MonitorPreferencesSchema,
  })
  .strict()

/** Main's error text when the picked event has left the game; the renderer matches it. */
export const EVENT_GONE_MESSAGE = 'Этого ивента уже нет в игре'

export type GameEvent = z.infer<typeof GameEventSchema>
export type ModeOptions = z.infer<typeof ModeOptionsSchema>
