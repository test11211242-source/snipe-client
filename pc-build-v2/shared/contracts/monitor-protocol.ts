import { z } from 'zod'

import {
  PixelSizeSchema,
  NormalizedRectSchema,
  TriggerProfileSchema,
} from '../models/capture'
import { PredictionRuntimeProfileSchema } from '../models/prediction-result'

export const MONITOR_PROTOCOL_VERSION = 4
export const MONITOR_MAX_COMMAND_LINE_BYTES = 1024 * 1024

const ProtocolBaseSchema = z.object({
  protocolVersion: z.literal(MONITOR_PROTOCOL_VERSION),
  sessionId: z.uuid(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})

export const MonitorCaptureSelectorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('window'),
      windowHwnd: z.string().regex(/^[1-9]\d{0,19}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('display'),
      displayDeviceName: z
        .string()
        .regex(/^\\\\\.\\DISPLAY\d+$/)
        .max(32),
      electronDisplayId: z.string().min(1).max(128),
    })
    .strict(),
])

export const MonitorLimitsSchema = z
  .object({
    fps: z.literal(10),
    maxImageBytes: z.literal(10 * 1024 * 1024),
    maxImagePixels: z.literal(20_000_000),
    maxImageWidth: z.literal(8192),
    maxImageHeight: z.literal(8192),
    confirmationsNeeded: z.literal(2),
    confirmationDecay: z.literal(0.5),
    cooldownSeconds: z.literal(15),
  })
  .strict()

const PixelRectSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()

const CanonicalBase64Schema = z
  .string()
  .max(87_384)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => {
    if (value.endsWith('==')) return /[AQgw]==$/.test(value)
    if (value.endsWith('=')) return /[AEIMQUYcgkosw048]=$/.test(value)
    return true
  }, 'Base64 must use canonical padding bits')

function decodedByteLength(value: string): number {
  return (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
}

const StripEdgesSchema = z
  .object({
    length: z.literal(256),
    thickness: z.number().int().min(1).max(256),
    angleQ8Base64: CanonicalBase64Schema,
    weightQ8Base64: CanonicalBase64Schema,
  })
  .strict()
  .superRefine((strip, context) => {
    for (const field of ['angleQ8Base64', 'weightQ8Base64'] as const) {
      if (decodedByteLength(strip[field]) !== strip.length * strip.thickness) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Invalid strip byte length',
        })
      }
    }
  })

export const MonitorWindowChromeSchema = z
  .object({
    top: z.number().int().min(0).max(2048),
    bottom: z.number().int().min(0).max(2048),
    left: z.number().int().min(0).max(2048),
    right: z.number().int().min(0).max(2048),
    topEdges: StripEdgesSchema.nullable(),
    bottomEdges: StripEdgesSchema.nullable(),
    leftEdges: StripEdgesSchema.nullable(),
    rightEdges: StripEdgesSchema.nullable(),
  })
  .strict()

export const MonitorVsBadgeSchema = z
  .object({
    cx: z.number().positive().max(1),
    cy: z.number().positive().max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()

export const MonitorVsOrientationTriggerSchema = z
  .object({
    kind: z.literal('vs_edge_orientation'),
    algorithm: z.literal('vs-orient-1'),
    badge: MonitorVsBadgeSchema,
    normalizedSize: z
      .object({
        width: z.literal(96),
        height: z.number().int().min(64).max(160),
      })
      .strict(),
    cropMargin: z.literal(0.08),
    padding: z.literal(4),
    maxShift: z.literal(3),
    threshold: z.literal(0.5),
    angleQ8Base64: CanonicalBase64Schema,
    weightQ8Base64: CanonicalBase64Schema,
    templateHash64: z.string().regex(/^[a-f0-9]{16}$/),
    maskAreaRatio: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((trigger, context) => {
    for (const field of ['angleQ8Base64', 'weightQ8Base64'] as const) {
      if (
        decodedByteLength(trigger[field]) !==
        trigger.normalizedSize.width * trigger.normalizedSize.height
      ) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Invalid orientation byte length',
        })
      }
    }
  })

const GameTriggerSchema = z.discriminatedUnion('kind', [
  MonitorVsOrientationTriggerSchema,
  z.object({ kind: z.literal('structural'), profile: TriggerProfileSchema }).strict(),
])

const MonitorRegionsSchema = z
  .object({
    trigger: NormalizedRectSchema,
    nicknameRegion: NormalizedRectSchema,
    topLeftEvidenceRegion: NormalizedRectSchema,
  })
  .strict()

const GameAspectSchema = z.number().min(0.397).max(0.773)

export const MonitorCommandLayoutSchema = z
  .object({
    layoutId: z.uuid(),
    layoutSource: z.enum(['setup', 'learned']),
    calibratedAt: z.iso.datetime(),
    gameAspect: GameAspectSchema,
    windowChrome: MonitorWindowChromeSchema,
    regions: MonitorRegionsSchema,
    trigger: GameTriggerSchema,
    badge: MonitorVsBadgeSchema.nullable(),
    zonesOrigin: z
      .object({
        nickname: z.enum(['auto', 'manual']),
        topLeftEvidence: z.enum(['auto', 'manual']),
      })
      .strict(),
  })
  .strict()

// Runtime-only shape; persisted calibration models remain unchanged until A3.
export const GameLayoutWireSchema = z
  .object({
    layoutId: z.uuid(),
    layoutSource: z.literal('learned'),
    calibratedAt: z.iso.datetime(),
    gameAspect: GameAspectSchema,
    referenceFrameSize: PixelSizeSchema,
    referenceGameRect: PixelRectSchema,
    windowChrome: MonitorWindowChromeSchema,
    expectedLayout: z.literal('cr_battle_vs'),
    triggerRegion: NormalizedRectSchema,
    nicknameRegion: NormalizedRectSchema,
    topLeftEvidenceRegion: NormalizedRectSchema,
    trigger: GameTriggerSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict()

const GameLayoutsSchema = z
  .array(MonitorCommandLayoutSchema)
  .min(1)
  .max(4)
  .superRefine((layouts, context) => {
    if (!layouts.some((layout) => layout.layoutSource === 'setup')) {
      context.addIssue({ code: 'custom', message: 'A setup layout is required' })
    }
    for (let index = 0; index < layouts.length; index += 1) {
      for (let previous = 0; previous < index; previous += 1) {
        const layout = layouts[index]
        const other = layouts[previous]
        if (layout === undefined || other === undefined) continue
        if (
          layout.layoutId === other.layoutId ||
          Math.abs(other.gameAspect / layout.gameAspect - 1) <= 0.03
        ) {
          context.addIssue({
            code: 'custom',
            path: [index],
            message: 'Layouts must have unique identities and distinct aspects',
          })
        }
      }
    }
  })

export const MonitorPrimarySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('full_frame'),
      configuredFrameSize: PixelSizeSchema,
      regions: MonitorRegionsSchema,
      triggerProfile: TriggerProfileSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('game_relative'),
      profileCalibrationId: z.uuid(),
      layouts: GameLayoutsSchema,
      learning: z.object({ enabled: z.boolean(), maxLayouts: z.literal(4) }).strict(),
    })
    .strict(),
])

export const MonitorStartPayloadSchema = z
  .object({
    selector: MonitorCaptureSelectorSchema,
    primary: MonitorPrimarySchema,
    capturePolicy: z.literal('immediate_nickname'),
    limits: MonitorLimitsSchema,
    prediction: PredictionRuntimeProfileSchema.nullable(),
  })
  .strict()

export const MonitorStartCommandSchema = ProtocolBaseSchema.extend({
  sequence: z.literal(0),
  type: z.literal('start'),
  payload: MonitorStartPayloadSchema,
}).strict()

export const MonitorStopCommandSchema = ProtocolBaseSchema.extend({
  type: z.literal('stop'),
  payload: z.object({}).strict(),
}).strict()

export const MonitorReadyEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('ready'),
  payload: z
    .object({
      frameWidth: z.number().int().positive().max(16_384),
      frameHeight: z.number().int().positive().max(16_384),
    })
    .strict(),
}).strict()

export const MonitorTriggeredEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('triggered'),
  payload: z
    .object({
      timestamp: z.iso.datetime(),
      triggerId: z.uuid(),
    })
    .strict(),
}).strict()

export const MonitorDiagnosticEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('diagnostic'),
  payload: z
    .object({
      profile: z.enum(['primary', 'prediction']),
      matcher: z.enum(['structural', 'vs_orientation']),
      matched: z.boolean(),
      score: z.number().min(0).max(1),
      support: z.number().min(0).max(1).nullable(),
      orientation: z.number().min(0).max(1).nullable(),
      correlation: z.number().min(-1).max(1).nullable(),
      orbInliers: z.number().int().nonnegative().max(1_000).nullable(),
      reason: z.enum(['pass', 'structure_below_threshold', 'no_candidate']),
    })
    .strict(),
}).strict()

export const MonitorActionEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('action'),
  payload: z
    .object({
      timestamp: z.iso.datetime(),
      triggerId: z.uuid(),
      width: z.number().int().positive().max(8192),
      height: z.number().int().positive().max(8192),
      byteLength: z
        .number()
        .int()
        .positive()
        .max(10 * 1024 * 1024),
      imageBase64: z.string().min(12).max(13_981_016),
    })
    .strict(),
}).strict()

export const MonitorPredictionResultEventSchema = MonitorActionEventSchema.extend({
  type: z.literal('prediction_result'),
}).strict()

export const MonitorFatalEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('fatal'),
  payload: z
    .object({
      code: z
        .string()
        .regex(/^[A-Z0-9_]+$/)
        .max(64),
      message: z.string().min(1).max(300),
      stage: z.enum(['initialize', 'start', 'frame', 'source', 'stop']).optional(),
      errorClass: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
        .optional(),
    })
    .strict(),
}).strict()

export const MonitorStoppedEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('stopped'),
  payload: z.object({}).strict(),
}).strict()

export const MonitorGeometryEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('geometry'),
  payload: z
    .object({
      state: z.enum([
        'locating',
        'armed',
        'no_game',
        'aspect_mismatch',
        'aspect_unknown',
      ]),
      frameWidth: PixelSizeSchema.shape.width,
      frameHeight: PixelSizeSchema.shape.height,
      gameRect: PixelRectSchema.nullable(),
      gameAspect: z.number().positive().nullable(),
      layoutId: z.uuid().nullable(),
    })
    .strict(),
}).strict()

export const MonitorLearningCodeSchema = z.enum([
  'LEARN_SPECTATE_LIKE',
  'LEARN_LAYOUT_UNEXPECTED',
  'LEARN_NICKNAME_ZONE_CLIPPED',
  'LEARN_TRIGGER_WEAK',
  'LEARN_SELF_CHECK_FAILED',
  'LEARN_ASPECT_UNSUPPORTED',
  'LEARN_STRUCTURAL_TRIGGER',
  'LEARN_GAME_NOT_FOUND',
  'LAYOUT_LIMIT',
])

export const MonitorLearningEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('learning'),
  payload: z
    .object({
      status: z.enum(['waiting_vs', 'rejected', 'failed']),
      reason: MonitorLearningCodeSchema.nullable(),
      rejectedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
}).strict()

export const MonitorLayoutLearnedEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('layout_learned'),
  payload: z
    .object({
      calibrationId: z.uuid(),
      layout: GameLayoutWireSchema,
      triggerId: z.uuid().nullable(),
    })
    .strict(),
}).strict()

export const MonitorPredictionStateEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('prediction_state'),
  payload: z.object({ state: z.enum(['active', 'aspect_mismatch']) }).strict(),
}).strict()

export const MonitorProcessEventSchema = z.discriminatedUnion('type', [
  MonitorReadyEventSchema,
  MonitorDiagnosticEventSchema,
  MonitorTriggeredEventSchema,
  MonitorActionEventSchema,
  MonitorPredictionResultEventSchema,
  MonitorGeometryEventSchema,
  MonitorLearningEventSchema,
  MonitorLayoutLearnedEventSchema,
  MonitorPredictionStateEventSchema,
  MonitorFatalEventSchema,
  MonitorStoppedEventSchema,
])

export type MonitorStartPayload = z.infer<typeof MonitorStartPayloadSchema>
export type MonitorProcessEvent = z.infer<typeof MonitorProcessEventSchema>
export type MonitorActionEvent = z.infer<typeof MonitorActionEventSchema>
export type GameLayoutWire = z.infer<typeof GameLayoutWireSchema>
export type MonitorGeometryEvent = z.infer<typeof MonitorGeometryEventSchema>
export type MonitorLearningEvent = z.infer<typeof MonitorLearningEventSchema>
export type MonitorLayoutLearnedEvent = z.infer<typeof MonitorLayoutLearnedEventSchema>
export type MonitorPredictionStateEvent = z.infer<
  typeof MonitorPredictionStateEventSchema
>
