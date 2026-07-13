import { z } from 'zod'

import {
  WidgetSettingsSchema,
  WidgetStatusSchema,
  WidgetViewSchema,
} from '../models/widget'

export const MAIN_WIDGET_IPC_CHANNELS = Object.freeze({
  getStatus: 'main-widget:get-status',
  show: 'main-widget:show',
  toggle: 'main-widget:toggle',
  updateSettings: 'main-widget:update-settings',
})

export const WIDGET_IPC_CHANNELS = Object.freeze({
  getView: 'widget:get-view',
  getCardAsset: 'widget:get-card-asset',
  updateSettings: 'widget:update-settings',
  hide: 'widget:hide',
})

export const EmptyWidgetPayloadSchema = z.object({}).strict()
export const WidgetSettingsPayloadSchema = WidgetSettingsSchema
export const WidgetSettingsResultSchema = WidgetSettingsSchema
export const WidgetStatusResultSchema = WidgetStatusSchema
export const WidgetViewResultSchema = WidgetViewSchema

export const CardAssetRequestSchema = z
  .object({
    resultId: z.uuid(),
    deckIndex: z.number().int().min(0).max(4),
    cardIndex: z.number().int().min(0).max(7),
  })
  .strict()

export const CardAssetResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
      dataUrl: z
        .string()
        .max(750_000)
        .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
    })
    .strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
])

export type CardAssetRequest = z.infer<typeof CardAssetRequestSchema>
export type CardAssetResult = z.infer<typeof CardAssetResultSchema>
