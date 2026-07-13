import { contextBridge, ipcRenderer } from 'electron'

import {
  AUTH_IPC_CHANNELS,
  ActivateInvitePayloadSchema,
  AuthViewResultSchema,
  EmptyPayloadSchema,
  LoginPayloadSchema,
  RegisterPayloadSchema,
} from '../../shared/contracts/auth-ipc'
import type { CrToolsAuthApi } from '../../shared/contracts/preload'
import type {
  ActivateInvitePayload,
  LoginPayload,
  RegisterPayload,
} from '../../shared/contracts/auth-ipc'

const emptyInvoke = async (channel: string) =>
  AuthViewResultSchema.parse(
    await ipcRenderer.invoke(channel, EmptyPayloadSchema.parse({})),
  )

const api: CrToolsAuthApi = Object.freeze({
  getView: () => emptyInvoke(AUTH_IPC_CHANNELS.getView),
  retryBootstrap: () => emptyInvoke(AUTH_IPC_CHANNELS.retryBootstrap),
  checkInvite: () => emptyInvoke(AUTH_IPC_CHANNELS.checkInvite),
  activateInvite: async (payload: ActivateInvitePayload) =>
    AuthViewResultSchema.parse(
      await ipcRenderer.invoke(
        AUTH_IPC_CHANNELS.activateInvite,
        ActivateInvitePayloadSchema.parse(payload),
      ),
    ),
  login: async (payload: LoginPayload) =>
    AuthViewResultSchema.parse(
      await ipcRenderer.invoke(
        AUTH_IPC_CHANNELS.login,
        LoginPayloadSchema.parse(payload),
      ),
    ),
  register: async (payload: RegisterPayload) =>
    AuthViewResultSchema.parse(
      await ipcRenderer.invoke(
        AUTH_IPC_CHANNELS.register,
        RegisterPayloadSchema.parse(payload),
      ),
    ),
})

contextBridge.exposeInMainWorld('crToolsAuth', api)
