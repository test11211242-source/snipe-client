import { ipcMain } from 'electron'
import {
  EmptyStreamerPayloadSchema,
  STREAMER_IPC_CHANNELS,
  StreamerActivePayloadSchema,
  StreamerCommandSchema,
  StreamerCommandResultSchema,
  StreamerReadinessSchema,
  StreamerViewResultSchema,
  StreamTitleSettingsPayloadSchema,
} from '../../../shared/contracts/streamer-ipc'
import {
  TITLE_BUILDER_CHANNELS,
  CompileTitlePayloadSchema,
  TitleCompileResultSchema,
  TitleBuilderSchema,
  compileTitle,
  decompileTitle,
} from '../../../shared/contracts/title-builder'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { SetupSessionService } from '../services/setup-session-service'
import type { StreamerService } from '../services/streamer-service'
import type { WindowCoordinator } from '../windows/window-coordinator'
import { verifyIpcSender } from './verify-ipc-sender'

interface Dependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  streamer: StreamerService
  setup: SetupSessionService
}
export function registerStreamerIpc(dependencies: Dependencies): () => void {
  ipcMain.handle(STREAMER_IPC_CHANNELS.command, async (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    const parsed = StreamerCommandSchema.safeParse(raw)
    if (!parsed.success)
      return StreamerCommandResultSchema.parse({
        ok: false,
        error: { code: 'VALIDATION_FAILED', detail: null },
      })
    return StreamerCommandResultSchema.parse(
      await dependencies.streamer.execute(parsed.data),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.readiness, async (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    EmptyStreamerPayloadSchema.parse(raw)
    return StreamerReadinessSchema.parse(await dependencies.streamer.getReadiness())
  })
  ipcMain.handle(TITLE_BUILDER_CHANNELS.compile, (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    const payload = CompileTitlePayloadSchema.safeParse(raw)
    if (!payload.success)
      return TitleCompileResultSchema.parse({ ok: false, code: 'VALIDATION_FAILED' })
    try {
      return TitleCompileResultSchema.parse({
        ok: true,
        settings: compileTitle(payload.data.settings, payload.data.builder),
      })
    } catch (error) {
      return TitleCompileResultSchema.parse({
        ok: false,
        code:
          error instanceof Error && error.message === 'TITLE_ACCOUNT_SELECTION_CONFLICT'
            ? 'TITLE_ACCOUNT_SELECTION_CONFLICT'
            : 'VALIDATION_FAILED',
      })
    }
  })
  ipcMain.handle(TITLE_BUILDER_CHANNELS.decompile, (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    return TitleBuilderSchema.parse(
      decompileTitle(StreamTitleSettingsPayloadSchema.parse(raw)),
    )
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.getView, (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    EmptyStreamerPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(dependencies.streamer.getView())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.refresh, async (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    EmptyStreamerPayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(await dependencies.streamer.refresh())
  })
  ipcMain.handle(STREAMER_IPC_CHANNELS.setActive, (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    const { active } = StreamerActivePayloadSchema.parse(raw)
    return StreamerViewResultSchema.parse(dependencies.streamer.setSectionActive(active))
  })
  // Legacy presentation adapter until the renderer cutover; session lives in main.
  ipcMain.handle(STREAMER_IPC_CHANNELS.startResultSetup, async (event, raw) => {
    verifyIpcSender(event, dependencies.windows, 'main')
    EmptyStreamerPayloadSchema.parse(raw)
    dependencies.streamer.ensureAccess()
    await dependencies.setup.startPredictionResult()
    return StreamerViewResultSchema.parse(dependencies.streamer.getView())
  })
  const channels = [
    ...Object.values(STREAMER_IPC_CHANNELS),
    ...Object.values(TITLE_BUILDER_CHANNELS),
  ]
  dependencies.logger.info('Streamer IPC registered', { channels })
  return () => channels.forEach((channel) => ipcMain.removeHandler(channel))
}
