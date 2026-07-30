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
import {
  EmptyUpdatePayloadSchema,
  UPDATE_IPC_CHANNELS,
  UpdateViewResultSchema,
} from '../../shared/contracts/update'

const emptyInvoke = async (channel: string) =>
  AuthViewResultSchema.parse(
    await ipcRenderer.invoke(channel, EmptyPayloadSchema.parse({})),
  )

const updateInvoke = async (channel: string) =>
  UpdateViewResultSchema.parse(
    await ipcRenderer.invoke(channel, EmptyUpdatePayloadSchema.parse({})),
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
  getUpdateView: () => updateInvoke(UPDATE_IPC_CHANNELS.getView),
  checkForUpdate: () => updateInvoke(UPDATE_IPC_CHANNELS.check),
  downloadUpdate: () => updateInvoke(UPDATE_IPC_CHANNELS.download),
  cancelUpdate: () => updateInvoke(UPDATE_IPC_CHANNELS.cancel),
  installUpdate: () => updateInvoke(UPDATE_IPC_CHANNELS.install),
})

contextBridge.exposeInMainWorld('crToolsAuth', api)
