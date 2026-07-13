import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  EmptyMonitorPayloadSchema,
  MONITOR_IPC_CHANNELS,
  MonitorPreferencesPayloadSchema,
  MonitorPreferencesResultSchema,
  MonitorViewResultSchema,
} from '../../../shared/contracts/monitor-ipc'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { MonitorSupervisor } from '../services/monitor-supervisor'
import type { WindowCoordinator } from '../windows/window-coordinator'

interface MonitorIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  monitor: MonitorSupervisor
}

function verify(event: IpcMainInvokeEvent, windows: WindowCoordinator): void {
  windows.assertSender(event.sender, event.senderFrame?.url ?? '', 'main')
}

export function registerMonitorIpc(dependencies: MonitorIpcDependencies): () => void {
  ipcMain.handle(MONITOR_IPC_CHANNELS.getView, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    EmptyMonitorPayloadSchema.parse(rawPayload)
    return MonitorViewResultSchema.parse(await dependencies.monitor.getView())
  })
  ipcMain.handle(MONITOR_IPC_CHANNELS.start, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    EmptyMonitorPayloadSchema.parse(rawPayload)
    return MonitorViewResultSchema.parse(await dependencies.monitor.start())
  })
  ipcMain.handle(MONITOR_IPC_CHANNELS.stop, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    EmptyMonitorPayloadSchema.parse(rawPayload)
    return MonitorViewResultSchema.parse(await dependencies.monitor.stop())
  })
  ipcMain.handle(MONITOR_IPC_CHANNELS.getPreferences, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    EmptyMonitorPayloadSchema.parse(rawPayload)
    return MonitorPreferencesResultSchema.parse(
      await dependencies.monitor.getPreferences(),
    )
  })
  ipcMain.handle(MONITOR_IPC_CHANNELS.updatePreferences, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    const preferences = MonitorPreferencesPayloadSchema.parse(rawPayload)
    return MonitorPreferencesResultSchema.parse(
      await dependencies.monitor.updatePreferences(preferences),
    )
  })
  const channels = Object.values(MONITOR_IPC_CHANNELS)
  dependencies.logger.info('Monitor IPC registered', { channels })
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
