import { z } from 'zod'

import {
  CaptureConfigurationSchema,
  NormalizedRegionsSchema,
  TriggerProfileSchema,
} from '../models/capture'
import { SearchModeSchema } from '../models/monitor'
import { PredictionRuntimeProfileSchema } from '../models/prediction-result'

const ProtocolBaseSchema = z.object({
  protocolVersion: z.literal(2),
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

export const MonitorStartPayloadSchema = z
  .object({
    selector: MonitorCaptureSelectorSchema,
    configuredFrameSize: CaptureConfigurationSchema.shape.frameSize,
    regions: NormalizedRegionsSchema,
    triggerProfile: TriggerProfileSchema,
    searchMode: SearchModeSchema,
    captureDelaySeconds: z.number().min(0).max(5),
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
    })
    .strict(),
}).strict()

export const MonitorActionEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('action'),
  payload: z
    .object({
      timestamp: z.iso.datetime(),
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
    })
    .strict(),
}).strict()

export const MonitorStoppedEventSchema = ProtocolBaseSchema.extend({
  type: z.literal('stopped'),
  payload: z.object({}).strict(),
}).strict()

export const MonitorProcessEventSchema = z.discriminatedUnion('type', [
  MonitorReadyEventSchema,
  MonitorTriggeredEventSchema,
  MonitorActionEventSchema,
  MonitorPredictionResultEventSchema,
  MonitorFatalEventSchema,
  MonitorStoppedEventSchema,
])

export type MonitorStartPayload = z.infer<typeof MonitorStartPayloadSchema>
export type MonitorProcessEvent = z.infer<typeof MonitorProcessEventSchema>
export type MonitorActionEvent = z.infer<typeof MonitorActionEventSchema>
