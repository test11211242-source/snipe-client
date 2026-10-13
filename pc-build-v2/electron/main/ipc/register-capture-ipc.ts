import { randomUUID } from 'node:crypto'

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  CapturePreparationResponseSchema,
  CapturePreparationResultSchema,
  CaptureProfileCommandSchema,
  CaptureProfileCommandResultSchema,
  CaptureProfileErrorCodeSchema,
  CaptureProfileNamePayloadSchema,
  CaptureProfilesResultSchema,
  CaptureStatusResultSchema,
  EmptyCapturePayloadSchema,
  DetectionPreviewPayloadSchema,
  DetectionPreviewResultSchema,
  MAIN_CAPTURE_IPC_CHANNELS,
  PreviewPayloadSchema,
  ReleasePreparationResultSchema,
  RebindCaptureProfilePayloadSchema,
  RetryDetectionResponseSchema,
  SETUP_IPC_CHANNELS,
  SetRegionPayloadSchema,
  SetupCommandSchema,
  SetupFrameResultSchema,
  SetupSessionResultSchema,
  SourceSnapshotResultSchema,
  SourcePreviewsPayloadSchema,
  StartSetupPayloadSchema,
} from '../../../shared/contracts/capture-ipc'
import { ApplicationError } from '../../../shared/errors/application-error'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { CaptureSourceRegistry } from '../services/capture-source-registry'
import type { CapturePreparationService } from '../services/capture-preparation-service'
import type { CaptureProfileService } from '../services/capture-profile-service'
import type { SetupSessionService } from '../services/setup-session-service'
import type { WindowCoordinator, WindowKind } from '../windows/window-coordinator'
import { verifyIpcSender } from './verify-ipc-sender'

interface CaptureIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  registry: CaptureSourceRegistry
  preparations: CapturePreparationService
  profiles: CaptureProfileService
  setup: SetupSessionService
}

function verify(event: IpcMainInvokeEvent, windows: WindowCoordinator, kind: WindowKind) {
  verifyIpcSender(event, windows, kind)
}

async function profileResult(call: () => Promise<unknown>) {
  try {
    const result = await call()
    return CaptureProfileCommandResultSchema.parse({ ok: true, ...(result as object) })
  } catch (error) {
    const code = CaptureProfileErrorCodeSchema.safeParse(
      error instanceof ApplicationError ? error.code : 'UNKNOWN',
    )
    return CaptureProfileCommandResultSchema.parse({
      ok: false,
      error: { code: code.success ? code.data : 'UNKNOWN' },
    })
  }
}
export function registerCaptureIpc(dependencies: CaptureIpcDependencies): () => void {
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.listSources, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return SourceSnapshotResultSchema.parse(await dependencies.registry.enumerate())
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.loadPreviews, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SourcePreviewsPayloadSchema.parse(rawPayload)
    return SourceSnapshotResultSchema.parse(
      await dependencies.registry.loadPreviews(payload.revision),
    )
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.prepareSource, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = PreviewPayloadSchema.parse(rawPayload)
    try {
      return CapturePreparationResponseSchema.parse({
        ok: true,
        preparation: CapturePreparationResultSchema.parse(
          await dependencies.preparations.prepare(payload.sourceKey, payload.revision),
        ),
      })
    } catch (error) {
      if (!(error instanceof ApplicationError)) {
        dependencies.logger.warn('Capture source preparation failed', { error })
      }
      return CapturePreparationResponseSchema.parse({
        ok: false,
        error:
          error instanceof ApplicationError
            ? error.toPublicError()
            : {
                code: 'CAPTURE_PREPARATION_FAILED',
                message: 'The selected source could not be prepared',
              },
      })
    }
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.releaseSource, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = PreviewPayloadSchema.parse(rawPayload)
    return ReleasePreparationResultSchema.parse({
      released: await dependencies.preparations.release(
        payload.sourceKey,
        payload.revision,
      ),
    })
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.startSetup, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = StartSetupPayloadSchema.parse(rawPayload)
    const target = {
      profileId: payload.profileId ?? randomUUID(),
      profileName: payload.profileName,
      expectedRevision: payload.expectedRevision,
    }
    if (payload.mode === 'auto') {
      const prepared = await dependencies.preparations.takeLive(payload.preparationId)
      try {
        return SetupSessionResultSchema.parse(
          await dependencies.setup.startAuto(
            prepared.source.selector,
            prepared.source.preference,
            prepared.capture,
            target,
          ),
        )
      } catch (error) {
        await prepared.capture.stop()
        throw error
      }
    }
    const prepared = await dependencies.preparations.freeze(payload.preparationId)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.start(
        prepared.source.selector,
        prepared.source.preference,
        'capture',
        prepared.frame,
        target,
      ),
    )
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.getStatus, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return CaptureStatusResultSchema.parse(await dependencies.setup.getStatus())
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.getProfiles, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return CaptureProfilesResultSchema.parse(await dependencies.profiles.getView())
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.activateProfile, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = CaptureProfileCommandSchema.parse(rawPayload)
    return profileResult(() =>
      dependencies.profiles.activate(payload.profileId, payload.expectedRevision),
    )
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.renameProfile, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = CaptureProfileNamePayloadSchema.parse(rawPayload)
    return profileResult(() =>
      dependencies.profiles.rename(
        payload.profileId,
        payload.profileName,
        payload.expectedRevision,
      ),
    )
  })
  ipcMain.handle(
    MAIN_CAPTURE_IPC_CHANNELS.duplicateProfile,
    async (event, rawPayload) => {
      verify(event, dependencies.windows, 'main')
      const payload = CaptureProfileNamePayloadSchema.parse(rawPayload)
      return profileResult(() =>
        dependencies.profiles.duplicate(
          payload.profileId,
          payload.profileName,
          payload.expectedRevision,
        ),
      )
    },
  )
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.deleteProfile, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = CaptureProfileCommandSchema.parse(rawPayload)
    return profileResult(() =>
      dependencies.profiles.delete(payload.profileId, payload.expectedRevision),
    )
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.rebindProfile, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = RebindCaptureProfilePayloadSchema.parse(rawPayload)
    return profileResult(async () => {
      const prepared = await dependencies.preparations.freeze(payload.preparationId)
      return dependencies.profiles.rebind(
        payload.profileId,
        prepared.source.preference,
        prepared.frame.size,
        payload.expectedRevision,
      )
    })
  })

  ipcMain.handle(SETUP_IPC_CHANNELS.startResult, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = CaptureProfileCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.startPredictionResult(
        payload.profileId,
        payload.expectedRevision,
      ),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.getSession, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(dependencies.setup.getSession())
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.getFrame, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupFrameResultSchema.parse(
      dependencies.setup.getFrame(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.retryDetection, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    try {
      return RetryDetectionResponseSchema.parse({
        ok: true,
        session: dependencies.setup.retryDetection(payload.sessionId, payload.generation),
      })
    } catch (error) {
      return RetryDetectionResponseSchema.parse({
        ok: false,
        error:
          error instanceof ApplicationError
            ? error.toPublicError()
            : { code: 'SETUP_FAILED', message: 'Не получилось настроить автоматически' },
      })
    }
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.switchToManual, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.switchToManual(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.getDetectionPreview, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = DetectionPreviewPayloadSchema.parse(rawPayload)
    return DetectionPreviewResultSchema.parse(
      dependencies.setup.getDetectionPreview(payload.sessionId),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.setRegion, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
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
  ipcMain.handle(SETUP_IPC_CHANNELS.finish, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetRegionPayloadSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.finish(
        payload.sessionId,
        payload.generation,
        payload.region,
        payload.rect,
      ),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.analyzeTrigger, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.analyzeTrigger(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.review, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      dependencies.setup.review(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.commit, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.commit(payload.sessionId, payload.generation),
    )
  })
  ipcMain.handle(SETUP_IPC_CHANNELS.retrySync, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      await dependencies.setup.retrySync(payload.sessionId, payload.generation),
    )
  })
  const cancel = (event: IpcMainInvokeEvent, rawPayload: unknown) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    return SetupSessionResultSchema.parse(
      dependencies.setup.cancel(payload.sessionId, payload.generation),
    )
  }
  ipcMain.handle(SETUP_IPC_CHANNELS.cancel, cancel)
  ipcMain.handle(SETUP_IPC_CHANNELS.close, (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = SetupCommandSchema.parse(rawPayload)
    const view = SetupSessionResultSchema.parse(
      dependencies.setup.close(payload.sessionId, payload.generation),
    )
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
