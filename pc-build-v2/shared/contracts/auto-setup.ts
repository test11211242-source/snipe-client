import { z } from 'zod'

import {
  NormalizedRegionsSchema,
  PixelRectSchema,
  PixelSizeSchema,
  VsBadgeSchema,
  VsOrientationTriggerSchema,
  WindowChromeSchema,
} from '../models/capture'
import { GameAspectSchema } from './game-aspect'

export const AutoSetupCodeSchema = z.enum([
  'AUTO_GAME_NOT_FOUND',
  'AUTO_ASPECT_UNSUPPORTED',
  'AUTO_VS_TIMEOUT',
  'AUTO_SPECTATE_LIKE',
  'AUTO_LAYOUT_UNEXPECTED',
  'AUTO_NICKNAME_ZONE_CLIPPED',
  'AUTO_TRIGGER_WEAK',
  'AUTO_SELF_CHECK_FAILED',
  'AUTO_SOURCE_LOST',
  'AUTO_INTERNAL_TIMEOUT',
  'AUTO_INTERNAL_ERROR',
])

const AnalysisGameSchema = z
  .object({ rect: PixelRectSchema, aspect: GameAspectSchema, chrome: WindowChromeSchema })
  .strict()
  .superRefine((game, context) => {
    if (
      game.rect.width < 50 ||
      game.rect.height < 50 ||
      Math.abs(game.aspect - game.rect.width / game.rect.height) > 1e-9
    ) {
      context.addIssue({
        code: 'custom',
        path: ['rect'],
        message: 'Invalid game geometry',
      })
    }
  })

export const AnalysisProgressSchema = z
  .object({
    phase: z.enum(['locating_game', 'waiting_vs', 'verifying']),
    elapsedMs: z.number().int().min(0).max(60_000),
    game: z
      .object({ rect: PixelRectSchema, aspect: GameAspectSchema })
      .strict()
      .refine(
        (game) =>
          game.rect.width >= 50 &&
          game.rect.height >= 50 &&
          Math.abs(game.aspect - game.rect.width / game.rect.height) <= 1e-9,
        'Invalid game geometry',
      )
      .nullable(),
    framesAnalyzed: z.number().int().nonnegative(),
  })
  .strict()

export const AnalysisResultSchema = z
  .discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        frameWidth: PixelSizeSchema.shape.width,
        frameHeight: PixelSizeSchema.shape.height,
        game: AnalysisGameSchema,
        badge: VsBadgeSchema,
        regions: NormalizedRegionsSchema,
        trigger: VsOrientationTriggerSchema,
        confidence: z.number().min(0).max(1),
        selfCheck: z
          .object({
            minVs: z.number().min(-1).max(1),
            maxBefore: z.number().min(-1).max(1),
            frames: z.number().int().min(2),
          })
          .strict(),
        timings: z
          .object({
            onsetMs: z.number().min(0).max(60_000),
            confirmMs: z.number().min(0).max(60_000),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        code: AutoSetupCodeSchema,
        frameWidth: PixelSizeSchema.shape.width.optional(),
        frameHeight: PixelSizeSchema.shape.height.optional(),
        game: AnalysisGameSchema.nullable().optional(),
        badge: VsBadgeSchema.nullable().optional(),
        regions: NormalizedRegionsSchema.nullable().optional(),
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if ((result.frameWidth === undefined) !== (result.frameHeight === undefined)) {
      context.addIssue({ code: 'custom', message: 'Frame dimensions must be paired' })
    }
    if (result.frameWidth !== undefined && result.frameHeight !== undefined) {
      if (result.frameWidth * result.frameHeight > 20_000_000) {
        context.addIssue({ code: 'custom', message: 'Frame is too large' })
      }
      if (
        result.game &&
        (result.game.rect.x + result.game.rect.width > result.frameWidth ||
          result.game.rect.y + result.game.rect.height > result.frameHeight)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['game'],
          message: 'Game exceeds frame',
        })
      }
    }
    if (
      result.badge &&
      (result.badge.cx - result.badge.width / 2 < 0 ||
        result.badge.cx + result.badge.width / 2 > 1 ||
        result.badge.cy - result.badge.height / 2 < 0 ||
        result.badge.cy + result.badge.height / 2 > 1)
    ) {
      context.addIssue({ code: 'custom', path: ['badge'], message: 'Badge exceeds game' })
    }
    if (result.ok) {
      if (result.timings.confirmMs < result.timings.onsetMs) {
        context.addIssue({
          code: 'custom',
          path: ['timings'],
          message: 'Invalid timings',
        })
      }
      for (const field of ['cx', 'cy', 'width', 'height'] as const) {
        if (result.badge[field] !== result.trigger.badge[field]) {
          context.addIssue({
            code: 'custom',
            path: ['trigger', 'badge'],
            message: 'Badge mismatch',
          })
        }
      }
    }
  })

export const DetectionPreviewSchema = z
  .object({
    width: z.number().int().positive().max(640),
    height: z.number().int().positive().max(640),
    mimeType: z.literal('image/jpeg'),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    bytes: z.instanceof(Uint8Array),
  })
  .strict()
  .refine(
    (preview) => preview.bytes.byteLength === preview.byteLength,
    'Invalid JPEG length',
  )

export type AutoSetupCode = z.infer<typeof AutoSetupCodeSchema>
export type AnalysisProgress = z.infer<typeof AnalysisProgressSchema>
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>
export type DetectionPreview = z.infer<typeof DetectionPreviewSchema>
