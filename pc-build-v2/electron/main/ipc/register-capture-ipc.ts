import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  CaptureStatusResultSchema,
  EmptyCapturePayloadSchema,
  MAIN_CAPTURE_IPC_CHANNELS,
  PreviewPayloadSchema,
  PreviewResultSchema,
  SETUP_IPC_CHANNELS,
  SetRegionPayloadSchema,
  SetupCommandSchema,
  SetupFrameResultSchema,
  SetupSessionResultSchema,
  SourceSnapshotResultSchema,
  StartSetupPayloadSchema,
} from '../../../shared/contracts/capture-ipc'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { CaptureSourceRegistry } from '../services/capture-source-registry'
import type { SetupSessionService } from '../services/setup-session-service'
import type { WindowCoordinator, WindowKind } from '../windows/window-coordinator'
import { verifyIpcSender } from './verify-ipc-sender'

interface CaptureIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  registry: CaptureSourceRegistry
  setup: SetupSessionService
}

function verify(event: IpcMainInvokeEvent, windows: WindowCoordinator, kind: WindowKind) {
  verifyIpcSender(event, windows, kind)
}

export function registerCaptureIpc(dependencies: CaptureIpcDependencies): () => void {
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.listSources, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return SourceSnapshotResultSchema.parse(await dependencies.registry.enumerate())
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.getPreview, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = PreviewPayloadSchema.parse(rawPayload)
    return PreviewResultSchema.parse(
      await dependencies.registry.getPreview(payload.sourceKey, payload.revision),
    )
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.startSetup, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = StartSetupPayloadSchema.parse(rawPayload)
    const source = await dependencies.registry.resolve(
      payload.sourceKey,
      payload.revision,
    )
    const view = await dependencies.setup.start(source.selector, source.preference)
    if (view.state !== 'CANCELLED' && view.state !== 'COMMITTED') {
      await dependencies.windows.ensureSetupWindow()
    }
    return SetupSessionResultSchema.parse(view)
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.getStatus, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return CaptureStatusResultSchema.parse(await dependencies.setup.getStatus())
  })

  ipcMain.handle(SETUP_IPC_CHANNELS.getSession, (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(dependencies.setup.getSession())
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.getFrame, (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupFrameResultSchema.parse(
      dependencies.setup.getFrame(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.setRegion, (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
    const payload = SetRegionPayloadSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      dependencies.setup.setRegion(
        payload.sessionId,
        payload.generation,
        payload.region,
        payload.rect,
      ),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.analyzeTrigger, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.analyzeTrigger(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.review, (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      dependencies.setup.review(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.commit, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.commit(payload.sessionId, payload.generation),
    )
  })
  const cancel = (event: IpcMainInvokeEvent, rawPayload: unknown) => {
    verify(event, dependencies.windows, 'setup')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      dependencies.setup.cancel(payload.sessionId, payload.generation),
    )
  }
  ipcMain.handle(SETUP_IPC_CHANNELS.cancel, cancel)
  ipcMain.handle(SETUP_IPC_CHANNELS.close, (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
    const payload = SetupCommandSchema.parse(rawPayload)
    const view = SetupSessionResultSchema.parse(
      dependencies.setup.close(payload.sessionId, payload.generation),
    )
    dependencies.windows.close('setup', 'setup-transition')
    return view
  })

  const channels = [
    ...Object.values(MAIN_CAPTURE_IPC_CHANNELS),
    ...Object.values(SETUP_IPC_CHANNELS),
  ]
  dependencies.logger.info('Capture IPC registered', { channels })
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
