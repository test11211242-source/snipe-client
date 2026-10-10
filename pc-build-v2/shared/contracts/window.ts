import { z } from 'zod'
export const WINDOW_CHANNEL = 'window:command'
export const WindowCommandSchema = z
  .object({ action: z.enum(['get', 'minimize', 'maximize', 'restore', 'close']) })
  .strict()
export const WindowViewSchema = z.object({ maximized: z.boolean() }).strict()
export type WindowAction = z.infer<typeof WindowCommandSchema>['action']
export type WindowView = z.infer<typeof WindowViewSchema>
