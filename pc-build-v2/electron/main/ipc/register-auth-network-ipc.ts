import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  AUTH_IPC_CHANNELS,
  ActivateInvitePayloadSchema,
  AuthViewResultSchema,
  EmptyPayloadSchema,
  LoginPayloadSchema,
  MAIN_NETWORK_IPC_CHANNELS,
  RealtimeStatusResultSchema,
  RegisterPayloadSchema,
} from '../../../shared/contracts/auth-ipc'
import type { StructuredLogger } from '../infrastructure/structured-logger'
import type { AuthSession } from '../services/auth-session'
import type { WebSocketSession } from '../services/websocket-session'
import type { WindowCoordinator, WindowKind } from '../windows/window-coordinator'
import { verifyIpcSender } from './verify-ipc-sender'

interface AuthNetworkIpcDependencies {
  windows: WindowCoordinator
  logger: StructuredLogger
  auth: AuthSession
  realtime: WebSocketSession
}

function verifySender(
  event: IpcMainInvokeEvent,
  windows: WindowCoordinator,
  kind: WindowKind,
): void {
  verifyIpcSender(event, windows, kind)
}

export function registerAuthNetworkIpc(
  dependencies: AuthNetworkIpcDependencies,
): () => void {
  const authQuery = (event: IpcMainInvokeEvent, rawPayload: unknown) => {
    verifySender(event, dependencies.windows, 'auth')
    EmptyPayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(dependencies.auth.getView())
  }
  ipcMain.handle(AUTH_IPC_CHANNELS.getView, authQuery)
  ipcMain.handle(AUTH_IPC_CHANNELS.retryBootstrap, async (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'auth')
    EmptyPayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(await dependencies.auth.retryBootstrap())
  })
  ipcMain.handle(AUTH_IPC_CHANNELS.checkInvite, async (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'auth')
    EmptyPayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(await dependencies.auth.checkInvite())
  })
  ipcMain.handle(AUTH_IPC_CHANNELS.activateInvite, async (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'auth')
    const payload = ActivateInvitePayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(
      await dependencies.auth.activateInvite(payload.inviteCode),
    )
  })
  ipcMain.handle(AUTH_IPC_CHANNELS.login, async (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'auth')
    const payload = LoginPayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(
      await dependencies.auth.login(payload.email, payload.password),
    )
  })
  ipcMain.handle(AUTH_IPC_CHANNELS.register, async (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'auth')
    const payload = RegisterPayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(
      await dependencies.auth.register(payload.email, payload.username, payload.password),
    )
  })
  ipcMain.handle(MAIN_NETWORK_IPC_CHANNELS.getAuthView, (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'main')
    EmptyPayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(dependencies.auth.getView())
  })
  ipcMain.handle(MAIN_NETWORK_IPC_CHANNELS.logout, async (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'main')
    EmptyPayloadSchema.parse(rawPayload)
    return AuthViewResultSchema.parse(await dependencies.auth.logout())
  })
  ipcMain.handle(MAIN_NETWORK_IPC_CHANNELS.getRealtimeStatus, (event, rawPayload) => {
    verifySender(event, dependencies.windows, 'main')
    EmptyPayloadSchema.parse(rawPayload)
    return RealtimeStatusResultSchema.parse(dependencies.realtime.getStatus())
  })

  const channels = [
    ...Object.values(AUTH_IPC_CHANNELS),
    ...Object.values(MAIN_NETWORK_IPC_CHANNELS),
  ]
  dependencies.logger.info('Auth and network IPC registered', { channels })
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
