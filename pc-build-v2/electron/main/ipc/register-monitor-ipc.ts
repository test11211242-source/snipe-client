import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  EmptyMonitorPayloadSchema,
  MONITOR_IPC_CHANNELS,
  MonitorPreferencesPayloadSchema,
  MonitorPreferencesResultSchema,
  MonitorViewResultSchema,
  RetrySearchPayloadSchema,
  MonitorHistoryPayloadSchema,
  MonitorHistoryResultSchema,
} from '../../../shared/contracts/monitor-ipc'
import { ModeOptionsSchema } from '../../../shared/contracts/game-events'
import type { MonitorPreferences } from '../../../shared/models/monitor'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { DeckModeService } from '../services/deck-mode-service'
import type { MonitorSupervisor } from '../services/monitor-supervisor'
import type { WidgetController } from '../services/widget-controller'
import type { WindowCoordinator } from '../windows/window-coordinator'
import { verifyIpcSender } from './verify-ipc-sender'

interface MonitorIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  monitor: MonitorSupervisor
  widget: WidgetController
  /** The search mode shared with the site; without it the mode stays local. */
  deckModes?: DeckModeService
}

function sameMode(a: MonitorPreferences, b: MonitorPreferences): boolean {
  return a.deckMode === b.deckMode && (a.event?.tag ?? null) === (b.event?.tag ?? null)
}

function verify(event: IpcMainInvokeEvent, windows: WindowCoordinator): void {
  verifyIpcSender(event, windows, 'main')
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
    const starting = dependencies.monitor.start()
    // Show the waiting window while preflight and worker startup are still running.
    void dependencies.widget.show().catch((error: unknown) => {
      dependencies.logger.warn('Could not open the monitor widget', { error })
    })
    return MonitorViewResultSchema.parse(await starting)
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
    // The server holds the mode for the site and this client; save there first.
    const saved =
      dependencies.deckModes === undefined
        ? preferences
        : await dependencies.deckModes.save(preferences)
    return MonitorPreferencesResultSchema.parse(
      await dependencies.monitor.updatePreferences(saved),
    )
  })
  ipcMain.handle(MONITOR_IPC_CHANNELS.getModeOptions, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    EmptyMonitorPayloadSchema.parse(rawPayload)
    const deckModes = dependencies.deckModes
    let preferences = await dependencies.monitor.getPreferences()
    if (deckModes === undefined)
      return ModeOptionsSchema.parse({ events: null, preferences })
    const [events, server] = await Promise.all([deckModes.listEvents(), deckModes.read()])
    // Picked on the site since: take the server's mode.
    if (server !== null && !sameMode(server, preferences))
      preferences = await dependencies.monitor.updatePreferences(server)
    return ModeOptionsSchema.parse({ events, preferences })
  })
  ipcMain.handle(MONITOR_IPC_CHANNELS.retrySearch, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    const payload = RetrySearchPayloadSchema.parse(rawPayload)
    return MonitorViewResultSchema.parse(
      await dependencies.monitor.retrySearch(payload.attemptId),
    )
  })
  ipcMain.handle(MONITOR_IPC_CHANNELS.getHistory, async (event, rawPayload) => {
    verify(event, dependencies.windows)
    const payload = MonitorHistoryPayloadSchema.parse(rawPayload)
    return MonitorHistoryResultSchema.parse(
      await dependencies.monitor.getHistory(payload.offset, payload.limit),
    )
  })
  const disposeResults = dependencies.monitor.subscribeViews((view) => {
    dependencies.windows.sendToRenderer(
      'main',
      MONITOR_IPC_CHANNELS.viewChanged,
      MonitorViewResultSchema.parse(view),
    )
  })
  const channels = Object.values(MONITOR_IPC_CHANNELS)
  dependencies.logger.info('Monitor IPC registered', { channels })
  return () => {
    disposeResults()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
