import { z } from 'zod'

import { MonitorPreferencesSchema, MonitorViewSchema } from '../models/monitor'

export const MONITOR_IPC_CHANNELS = Object.freeze({
  getView: 'monitor:get-view',
  viewChanged: 'monitor:view-changed',
  start: 'monitor:start',
  stop: 'monitor:stop',
  getPreferences: 'monitor:get-preferences',
  updatePreferences: 'monitor:update-preferences',
})

export const EmptyMonitorPayloadSchema = z.object({}).strict()
export const MonitorViewResultSchema = MonitorViewSchema
export const MonitorPreferencesPayloadSchema = MonitorPreferencesSchema
export const MonitorPreferencesResultSchema = MonitorPreferencesSchema
