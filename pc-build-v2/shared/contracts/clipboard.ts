import { z } from 'zod'
import { GameAccountTagSchema } from '../models/streamer'

export const CLIPBOARD_CHANNELS = Object.freeze({
  mainCopyTag: 'ui:copy-player-tag',
  widgetCopyTag: 'widget:copy-player-tag',
})
export const CopyPlayerTagPayloadSchema = z.object({ tag: GameAccountTagSchema }).strict()
export const CopyPlayerTagResultSchema = z.object({ copied: z.literal(true) }).strict()
export type CopyPlayerTagResult = z.infer<typeof CopyPlayerTagResultSchema>
