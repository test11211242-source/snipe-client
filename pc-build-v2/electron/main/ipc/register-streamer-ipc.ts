import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  EmptyStreamerPayloadSchema,
  OverlayCopyPayloadSchema,
  OverlaySettingsPayloadSchema,
  PredictionPreferencesPayloadSchema,
  STREAMER_IPC_CHANNELS,
  StreamerAccountPayloadSchema,
  StreamerActivePayloadSchema,
  StreamerBooleanPayloadSchema,
  StreamerConfirmationPayloadSchema,
  StreamerPausedPayloadSchema,
  StreamerTagPayloadSchema,
  StreamerViewResultSchema,
  StreamTitleSettingsPayloadSchema,
} from '../../../shared/contracts/streamer-ipc'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { SetupSessionService } from '../services/setup-session-service'
import type { StreamerService } from '../services/streamer-service'
import type { WindowCoordinator } from '../windows/window-coordinator'

interface Dependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  streamer: StreamerService
  setup: SetupSessionService
}

function verify(event: IpcMainInvokeEvent, windows: WindowCoordinator): void {
  windows.assertSender(event.sender, event.senderFrame?.url ?? '', 'main')
}

export function registerStreamerIpc(dependencies: Dependencies): () => void {
  const empty = (event: IpcMainInvokeEvent, raw: unknown): void => {
    verify(event, dependencies.windows)
    EmptyStreamerPayloadSchema.parse(raw)
  }
  ipcMain.handle(STREAMER_IPC_CHANNELS.getView, (event, raw) => {
    empty(event, raw)
    return StreamerViewResultSchema.parse(dependencies.streamer.getView())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.refresh, async (event, raw) => {
    empty(event, raw)
    return StreamerViewResultSchema.parse(await dependencies.streamer.refresh())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.setActive, (event, raw) => {
    verify(event, dependencies.windows)
    const { active } = StreamerActivePayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(dependencies.streamer.setSectionActive(active))
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.connectTwitch, async (event, raw) => {
    empty(event, raw)
    return StreamerViewResultSchema.parse(await dependencies.streamer.connectTwitch())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.disconnectTwitch, async (event, raw) => {
    verify(event, dependencies.windows)
    StreamerConfirmationPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(await dependencies.streamer.disconnectTwitch())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.startPredictions, async (event, raw) => {
    verify(event, dependencies.windows)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.startPredictions(
        PredictionPreferencesPayloadSchema.parse(raw),
      ),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.stopPredictions, async (event, raw) => {
    empty(event, raw)
    return StreamerViewResultSchema.parse(await dependencies.streamer.stopPredictions())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.startResultSetup, async (event, raw) => {
    empty(event, raw)
    dependencies.streamer.ensureAccess()
    await dependencies.setup.startPredictionResult()
    await dependencies.windows.ensureSetupWindow()
    return StreamerViewResultSchema.parse(dependencies.streamer.getView())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.updateTitle, async (event, raw) => {
    verify(event, dependencies.windows)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.updateTitle(
        StreamTitleSettingsPayloadSchema.parse(raw),
      ),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.setTitleEnabled, async (event, raw) => {
    verify(event, dependencies.windows)
    const { enabled } = StreamerBooleanPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.setTitleEnabled(enabled),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.setTitlePaused, async (event, raw) => {
    verify(event, dependencies.windows)
    const { paused } = StreamerPausedPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.setTitlePaused(paused),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.addTitleAccount, async (event, raw) => {
    verify(event, dependencies.windows)
    const payload = StreamerAccountPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.addTitleAccount(payload.tag, payload.alias),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.removeTitleAccount, async (event, raw) => {
    verify(event, dependencies.windows)
    const { tag } = StreamerTagPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.removeTitleAccount(tag),
    )
  })
  for (const [channel, command] of [
    [STREAMER_IPC_CHANNELS.resetTitle, 'reset'],
    [STREAMER_IPC_CHANNELS.undoTitle, 'undo'],
    [STREAMER_IPC_CHANNELS.restoreTitle, 'restore-title'],
  ] as const) {
    ipcMain.handle(channel, async (event, raw) => {
      verify(event, dependencies.windows)
      StreamerConfirmationPayloadSchema.parse(raw)
      return StreamerViewResultSchema.parse(
        await dependencies.streamer.titleCommand(command),
      )
    })
  }
  ipcMain.handle(STREAMER_IPC_CHANNELS.setDeckSharing, async (event, raw) => {
    verify(event, dependencies.windows)
    const { enabled } = StreamerBooleanPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.setDeckSharing(enabled),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.updateOverlay, async (event, raw) => {
    verify(event, dependencies.windows)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.updateOverlay(OverlaySettingsPayloadSchema.parse(raw)),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.rotateOverlayToken, async (event, raw) => {
    verify(event, dependencies.windows)
    StreamerConfirmationPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(
      await dependencies.streamer.rotateOverlayToken(),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.copyOverlayUrl, (event, raw) => {
    verify(event, dependencies.windows)
    const { kind } = OverlayCopyPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(dependencies.streamer.copyOverlayUrl(kind))
  })
  const channels = Object.values(STREAMER_IPC_CHANNELS)
  dependencies.logger.info('Streamer IPC registered', { channels })
  return () => channels.forEach((channel) => ipcMain.removeHandler(channel))
}
