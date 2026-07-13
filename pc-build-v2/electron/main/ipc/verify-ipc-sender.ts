import type { IpcMainInvokeEvent } from 'electron'

import type { WindowCoordinator, WindowKind } from '../windows/window-coordinator'

export function resolveIpcSenderUrl(event: IpcMainInvokeEvent): string {
  const frameUrl = event.senderFrame?.url
  return frameUrl === undefined || frameUrl.length === 0
    ? event.sender.getURL()
    : frameUrl
}

export function verifyIpcSender(
  event: IpcMainInvokeEvent,
  windows: WindowCoordinator,
  kind: WindowKind,
): void {
  windows.assertSender(event.sender, resolveIpcSenderUrl(event), kind)
}
