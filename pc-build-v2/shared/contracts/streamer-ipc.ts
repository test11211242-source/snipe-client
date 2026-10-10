import { z } from 'zod'

import {
  OverlaySettingsSchema,
  OverlayUrlKindSchema,
  PredictionPreferencesSchema,
  StreamerConfirmationSchema,
  StreamerViewSchema,
  StreamTitlePreviewSchema,
  StreamTitleSettingsSchema,
} from '../models/streamer'

export const STREAMER_IPC_CHANNELS = Object.freeze({
  getView: 'streamer:get-view',
  refresh: 'streamer:refresh',
  setActive: 'streamer:set-section-active',
  connectTwitch: 'streamer:connect-twitch',
  disconnectTwitch: 'streamer:disconnect-twitch',
  startPredictions: 'streamer:start-predictions',
  stopPredictions: 'streamer:stop-predictions',
  startResultSetup: 'streamer:start-result-setup',
  updateTitle: 'streamer:update-title',
  previewTitle: 'streamer:preview-title',
  setTitleEnabled: 'streamer:set-title-enabled',
  setTitlePaused: 'streamer:set-title-paused',
  addTitleAccount: 'streamer:add-title-account',
  removeTitleAccount: 'streamer:remove-title-account',
  resetTitle: 'streamer:reset-title',
  undoTitle: 'streamer:undo-title',
  restoreTitle: 'streamer:restore-title',
  setDeckSharing: 'streamer:set-deck-sharing',
  updateOverlay: 'streamer:update-overlay',
  rotateOverlayToken: 'streamer:rotate-overlay-token',
  copyOverlayUrl: 'streamer:copy-overlay-url',
})

export const EmptyStreamerPayloadSchema = z.object({}).strict()
export const StreamerViewResultSchema = StreamerViewSchema
export const StreamerActivePayloadSchema = z.object({ active: z.boolean() }).strict()
export const PredictionPreferencesPayloadSchema = PredictionPreferencesSchema
export const StreamTitleSettingsPayloadSchema = StreamTitleSettingsSchema
export const StreamTitlePreviewResultSchema = StreamTitlePreviewSchema
export const StreamerBooleanPayloadSchema = z.object({ enabled: z.boolean() }).strict()
export const StreamerPausedPayloadSchema = z.object({ paused: z.boolean() }).strict()
export const StreamerAccountPayloadSchema = z
  .object({ tag: z.string().trim().min(2).max(20), alias: z.string().trim().max(100) })
  .strict()
export const StreamerTagPayloadSchema = z
  .object({ tag: z.string().trim().min(2).max(20) })
  .strict()
export const OverlaySettingsPayloadSchema = OverlaySettingsSchema
export const OverlayCopyPayloadSchema = z.object({ kind: OverlayUrlKindSchema }).strict()
export const StreamerConfirmationPayloadSchema = StreamerConfirmationSchema

export const AccountErrorCodeSchema = z.enum([
  'ACCOUNT_TAG_INVALID',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_LIMIT_REACHED',
  'CLASH_API_UNAVAILABLE',
  'ACCOUNT_SAVE_UNAVAILABLE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'STREAMER_ROLE_REQUIRED',
  'STREAMER_CANCELLED',
  'UNKNOWN',
])
export const AccountMutationResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      view: StreamerViewSchema,
      warning: z.enum(['TITLE_UPDATE_FAILED', 'REFRESH_FAILED']).nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: AccountErrorCodeSchema,
          detail: z.string().max(300).nullable(),
        })
        .strict(),
    })
    .strict(),
])
export type AccountMutationResult = z.infer<typeof AccountMutationResultSchema>
