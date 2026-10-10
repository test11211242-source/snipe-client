import { z } from 'zod'

import {
  OverlaySettingsSchema,
  OverlayUrlKindSchema,
  PredictionPreferencesSchema,
  StreamerConfirmationSchema,
  StreamerViewSchema,
  StreamTitlePreviewSchema,
  StreamTitleSettingsSchema,
  GameAccountTagSchema,
} from '../models/streamer'

export const STREAMER_IPC_CHANNELS = Object.freeze({
  command: 'streamer:command',
  readiness: 'streamer:readiness',
  getView: 'streamer:get-view',
  refresh: 'streamer:refresh',
  setActive: 'streamer:set-section-active',
  startResultSetup: 'streamer:start-result-setup',
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

export const StreamerCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('twitch.connect') }).strict(),
  z
    .object({ action: z.literal('twitch.disconnect'), confirmed: z.literal(true) })
    .strict(),
  z
    .object({
      action: z.literal('predictions.start'),
      settings: PredictionPreferencesSchema,
    })
    .strict(),
  z.object({ action: z.literal('predictions.stop') }).strict(),
  z
    .object({
      action: z.enum(['title.save', 'title.preview', 'title.apply']),
      settings: StreamTitleSettingsSchema,
    })
    .strict(),
  z.object({ action: z.literal('title.enabled'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('title.paused'), paused: z.boolean() }).strict(),
  z
    .object({
      action: z.enum(['title.reset', 'title.undo', 'title.restore']),
      confirmed: z.literal(true),
    })
    .strict(),
  z.object({ action: z.literal('chat.toggle'), enabled: z.boolean() }).strict(),
  z
    .object({ action: z.literal('widget.settings'), settings: OverlaySettingsSchema })
    .strict(),
  z.object({ action: z.literal('widget.enabled'), enabled: z.boolean() }).strict(),
  z
    .object({ action: z.literal('widget.resetToken'), confirmed: z.literal(true) })
    .strict(),
  z.object({ action: z.literal('widget.copy'), kind: OverlayUrlKindSchema }).strict(),
  z
    .object({
      action: z.literal('accounts.add'),
      tag: z.string().trim().min(2).max(20),
      alias: z.string().trim().max(100),
    })
    .strict(),
  z
    .object({
      action: z.enum(['accounts.remove', 'accounts.reenable']),
      tag: GameAccountTagSchema,
    })
    .strict(),
])
export const StreamerCommandErrorCodeSchema = z.enum([
  ...AccountErrorCodeSchema.options,
  'VALIDATION_FAILED',
  'NETWORK_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'SERVER_ERROR',
  'INVALID_RESPONSE',
  'STREAMER_COMMAND_FAILED',
  'TWITCH_OAUTH_URL_REJECTED',
  'TWITCH_REQUIRED',
  'RESULT_SETUP_REQUIRED',
  'CAPTURE_NOT_CONFIGURED',
  'PREDICTION_CANCELLED',
  'PREDICTION_AUTH_CHANGED',
  'PREDICTION_START_FAILED',
  'PREDICTION_LOCAL_START_FAILED',
  'PREDICTION_ROLLBACK_UNKNOWN',
  'PREDICTION_ALREADY_ACTIVE',
  'PREDICTION_STOP_UNKNOWN',
  'PREDICTION_MONITOR_RESTART_FAILED',
  'OVERLAY_URL_UNAVAILABLE',
  'TITLE_ACCOUNT_SELECTION_CONFLICT',
  'TITLE_APPLY_UNAVAILABLE',
])
export const StreamerWarningCodeSchema = z.enum([
  'TITLE_UPDATE_FAILED',
  'REFRESH_FAILED',
  'TITLE_APPLICATION_UNCONFIRMED',
])
export const StreamerCommandResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      view: StreamerViewSchema,
      preview: StreamTitlePreviewSchema.nullable(),
      warnings: z.array(StreamerWarningCodeSchema).max(3),
      titleApplication: z.enum(['not_requested', 'unconfirmed', 'failed']),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: StreamerCommandErrorCodeSchema,
          detail: z.string().max(300).nullable(),
        })
        .strict(),
    })
    .strict(),
])
export const StreamerReadinessSchema = z
  .object({
    twitchConnected: z.boolean().nullable(),
    accountsCount: z.number().int().min(0).max(20).nullable(),
    monitoring: z.boolean().nullable(),
    captureConfigured: z.boolean().nullable(),
    resultZonesConfigured: z.boolean().nullable(),
    activeProfileId: z.uuid().nullable(),
  })
  .strict()
export type StreamerCommand = z.infer<typeof StreamerCommandSchema>
export type StreamerCommandResult = z.infer<typeof StreamerCommandResultSchema>
export type StreamerReadiness = z.infer<typeof StreamerReadinessSchema>
