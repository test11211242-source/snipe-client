import { clipboard, ipcMain } from 'electron'
import {
  CLIPBOARD_CHANNELS,
  CopyPlayerTagPayloadSchema,
  CopyPlayerTagResultSchema,
} from '../../../shared/contracts/clipboard'
import {
  H2H_CHANNELS,
  H2HCancelSchema,
  H2HLookupResultSchema,
  H2HRequestSchema,
} from '../../../shared/contracts/h2h'
import {
  WINDOW_CHANNEL,
  WindowCommandSchema,
  WindowViewSchema,
} from '../../../shared/contracts/window'
import type { WindowCoordinator } from '../windows/window-coordinator'
import type { H2HService } from '../services/h2h-service'
import type { AuthSession } from '../services/auth-session'
import { verifyIpcSender } from './verify-ipc-sender'

export function registerUiIpc(
  windows: WindowCoordinator,
  h2h: H2HService | undefined,
  auth: AuthSession,
) {
  ipcMain.handle(CLIPBOARD_CHANNELS.mainCopyTag, (event, raw) => {
    verifyIpcSender(event, windows, 'main')
    const payload = CopyPlayerTagPayloadSchema.parse(raw)
    clipboard.writeText(payload.tag)
    return CopyPlayerTagResultSchema.parse({ copied: true })
  })
  ipcMain.handle(WINDOW_CHANNEL, (event, raw) => {
    verifyIpcSender(event, windows, 'main')
    return WindowViewSchema.parse(
      windows.mainWindowCommand(WindowCommandSchema.parse(raw).action),
    )
  })
  ipcMain.handle(H2H_CHANNELS.lookup, async (event, raw) => {
    verifyIpcSender(event, windows, 'main')
    const payload = H2HRequestSchema.parse(raw)
    if (h2h === undefined) throw new Error('H2H service is unavailable')
    return H2HLookupResultSchema.parse(await h2h.lookup(payload))
  })
  ipcMain.handle(H2H_CHANNELS.cancel, (event, raw) => {
    verifyIpcSender(event, windows, 'main')
    const payload = H2HCancelSchema.parse(raw)
    h2h?.cancel(payload.requestId)
  })
  let generation = auth.getContextGeneration()
  const disposeAuth =
    h2h === undefined
      ? undefined
      : auth.subscribe(() => {
          const next = auth.getContextGeneration()
          if (generation !== next) h2h.cancelAll()
          generation = next
        })
  const disposeWindow = windows.onWindowClosed((kind) => {
    if (kind === 'main') h2h?.cancelAll()
  })
  return () => {
    disposeAuth?.()
    disposeWindow()
    h2h?.cancelAll()
    for (const channel of [
      WINDOW_CHANNEL,
      CLIPBOARD_CHANNELS.mainCopyTag,
      ...Object.values(H2H_CHANNELS),
    ])
      ipcMain.removeHandler(channel)
  }
}
