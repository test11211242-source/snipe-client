import { z } from 'zod'

const SafeTextSchema = z.string().trim().min(1).max(160)

export const WIDGET_MIN_WIDTH = 340
export const WIDGET_MAX_WIDTH = 720
export const WIDGET_MIN_HEIGHT = 300
export const WIDGET_MAX_HEIGHT = 900

export const WidgetBoundsSchema = z
  .object({
    x: z.number().int().min(-32_768).max(32_767).nullable(),
    y: z.number().int().min(-32_768).max(32_767).nullable(),
    width: z.number().int().min(WIDGET_MIN_WIDTH).max(WIDGET_MAX_WIDTH),
    height: z.number().int().min(WIDGET_MIN_HEIGHT).max(WIDGET_MAX_HEIGHT),
  })
  .strict()

export const WidgetSettingsSchema = z
  .object({
    autoOpen: z.boolean(),
    alwaysOnTop: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().min(0.55).max(1),
    compactMode: z.boolean(),
    bounds: WidgetBoundsSchema,
  })
  .strict()

const WidgetCardSchema = z
  .object({
    name: SafeTextSchema,
    level: z.number().int().min(0).max(100).nullable(),
    evolutionLevel: z.number().int().min(0).max(10).nullable(),
    hasImage: z.boolean(),
  })
  .strict()

const WidgetDeckSchema = z
  .object({
    label: SafeTextSchema.nullable(),
    cards: z.array(WidgetCardSchema).max(8),
  })
  .strict()

const WidgetResultBaseSchema = z.object({
  id: z.uuid(),
  timestamp: z.iso.datetime(),
  searchedNickname: SafeTextSchema.nullable(),
})

export const WidgetResultSchema = z.discriminatedUnion('kind', [
  WidgetResultBaseSchema.extend({
    kind: z.literal('player_found'),
    player: z
      .object({
        name: SafeTextSchema,
        tag: SafeTextSchema.nullable(),
        rating: z.number().int().min(0).max(100_000).nullable(),
        clan: SafeTextSchema.nullable(),
      })
      .strict(),
    decks: z.array(WidgetDeckSchema).max(5),
  }).strict(),
  WidgetResultBaseSchema.extend({
    kind: z.literal('player_not_found'),
    message: SafeTextSchema,
  }).strict(),
  WidgetResultBaseSchema.extend({
    kind: z.literal('recognition_failed'),
    message: SafeTextSchema,
  }).strict(),
  WidgetResultBaseSchema.extend({
    kind: z.literal('service_error'),
    message: SafeTextSchema,
  }).strict(),
])

export const WidgetViewSchema = z
  .object({
    settings: WidgetSettingsSchema,
    visible: z.boolean(),
    result: WidgetResultSchema.nullable(),
  })
  .strict()

export const WidgetStatusSchema = z
  .object({
    settings: WidgetSettingsSchema,
    visible: z.boolean(),
    hasResult: z.boolean(),
  })
  .strict()

export type WidgetBounds = z.infer<typeof WidgetBoundsSchema>
export type WidgetSettings = z.infer<typeof WidgetSettingsSchema>
export type WidgetResult = z.infer<typeof WidgetResultSchema>
export type WidgetView = z.infer<typeof WidgetViewSchema>
export type WidgetStatus = z.infer<typeof WidgetStatusSchema>
