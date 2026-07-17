import { randomUUID } from 'node:crypto'

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  CapturePreparationResultSchema,
  CaptureProfileCommandSchema,
  CaptureProfileMutationResultSchema,
  CaptureProfileNamePayloadSchema,
  CaptureProfilesResultSchema,
  CaptureStatusResultSchema,
  EmptyCapturePayloadSchema,
  MAIN_CAPTURE_IPC_CHANNELS,
  PreviewPayloadSchema,
  ReleasePreparationResultSchema,
  RebindCaptureProfilePayloadSchema,
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

export function registerCaptureIpc(dependencies: CaptureIpcDependencies): () => void {
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.listSources, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return SourceSnapshotResultSchema.parse(await dependencies.registry.enumerate())
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.prepareSource, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = PreviewPayloadSchema.parse(rawPayload)
    return CapturePreparationResultSchema.parse(
      await dependencies.preparations.prepare(payload.sourceKey, payload.revision),
    )
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
    const prepared = await dependencies.preparations.freeze(payload.preparationId)
    const view = await dependencies.setup.start(
      prepared.source.selector,
      prepared.source.preference,
      'capture',
      prepared.frame,
      {
        profileId: payload.profileId ?? randomUUID(),
        profileName: payload.profileName,
        expectedRevision: payload.expectedRevision,
      },
    )
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
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.getProfiles, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    EmptyCapturePayloadSchema.parse(rawPayload)
    return CaptureProfilesResultSchema.parse(await dependencies.profiles.getView())
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.activateProfile, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = CaptureProfileCommandSchema.parse(rawPayload)
    return CaptureProfileMutationResultSchema.parse(
      await dependencies.profiles.activate(payload.profileId, payload.expectedRevision),
    )
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.renameProfile, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = CaptureProfileNamePayloadSchema.parse(rawPayload)
    return CaptureProfileMutationResultSchema.parse(
      await dependencies.profiles.rename(
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
      return CaptureProfileMutationResultSchema.parse(
        await dependencies.profiles.duplicate(
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
    return CaptureProfileMutationResultSchema.parse(
      await dependencies.profiles.delete(payload.profileId, payload.expectedRevision),
    )
  })
  ipcMain.handle(MAIN_CAPTURE_IPC_CHANNELS.rebindProfile, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'main')
    const payload = RebindCaptureProfilePayloadSchema.parse(rawPayload)
    const prepared = await dependencies.preparations.freeze(payload.preparationId)
    return CaptureProfileMutationResultSchema.parse(
      await dependencies.profiles.rebind(
        payload.profileId,
        prepared.source.preference,
        prepared.frame.size,
        payload.expectedRevision,
      ),
    )
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
  ipcMain.handle(SETUP_IPC_CHANNELS.finish, async (event, rawPayload) => {
    verify(event, dependencies.windows, 'setup')
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
