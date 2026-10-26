import { z } from 'zod'

import {
  MonitorPreferencesSchema,
  MonitorResultSchema,
  MonitorViewSchema,
} from '../models/monitor'

export const MONITOR_IPC_CHANNELS = Object.freeze({
  getView: 'monitor:get-view',
  viewChanged: 'monitor:view-changed',
  start: 'monitor:start',
  stop: 'monitor:stop',
  getPreferences: 'monitor:get-preferences',
  updatePreferences: 'monitor:update-preferences',
  retrySearch: 'monitor:retry-search',
  getHistory: 'monitor:get-history',
  getModeOptions: 'monitor:get-mode-options',
})

export const EmptyMonitorPayloadSchema = z.object({}).strict()
export const MonitorViewResultSchema = MonitorViewSchema
export const MonitorPreferencesPayloadSchema = MonitorPreferencesSchema
export const MonitorPreferencesResultSchema = MonitorPreferencesSchema
export const RetrySearchPayloadSchema = z.object({ attemptId: z.uuid() }).strict()
export const MonitorHistoryPayloadSchema = z
  .object({
    offset: z.number().int().min(0).max(2_000),
    limit: z.number().int().min(1).max(100),
  })
  .strict()
export const MonitorHistoryResultSchema = z.array(MonitorResultSchema).max(100)
