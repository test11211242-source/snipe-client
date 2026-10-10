// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CrToolsApi } from '../../../shared/contracts/preload'
import { IPC_CHANNELS } from '../../../shared/contracts/app'
import { MAIN_WIDGET_IPC_CHANNELS } from '../../../shared/contracts/widget-ipc'
const transport = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  ipcRenderer: { invoke: transport.invoke, on: vi.fn(), removeListener: vi.fn() },
  contextBridge: {
    exposeInMainWorld: (_name: string, api: CrToolsApi) => {
      Object.defineProperty(window, 'crTools', {
        configurable: true,
        value: {
          ...api,
          // Electron copies standard Error.message, not the isolated world's custom properties.
          getWidgetStatus: async () => {
            try {
              return await api.getWidgetStatus()
            } catch (reason) {
              throw new Error(reason instanceof Error ? reason.message : 'bridge error')
            }
          },
        },
      })
    },
  },
}))
import '../../../electron/preload/main'
import { useAppBootstrap } from './useAppBootstrap'

describe('bootstrap preload error transport', () => {
  it.each(['INVALID_RESPONSE', 'IPC_FAILED'] as const)(
    'retains safe %s after standard Error copying',
    async (code) => {
      transport.invoke.mockImplementation((channel) => {
        if (channel === MAIN_WIDGET_IPC_CHANNELS.getStatus) {
          return code === 'INVALID_RESPONSE'
            ? Promise.resolve({ unsafe: 'private response' })
            : Promise.reject(new Error('private IPC cause'))
        }
        if (channel === IPC_CHANNELS.reportBootstrapFailure)
          return Promise.resolve(undefined)
        return new Promise(() => undefined)
      })
      const hook = renderHook(() => useAppBootstrap())
      await waitFor(() => expect(hook.result.current.data.widget.cause).toBe(code))
      expect(transport.invoke).toHaveBeenCalledWith(IPC_CHANNELS.reportBootstrapFailure, {
        capability: 'widget',
        code,
      })
      expect(JSON.stringify(hook.result.current.data.widget)).not.toContain('private')
      hook.unmount()
      transport.invoke.mockReset()
    },
  )
})
