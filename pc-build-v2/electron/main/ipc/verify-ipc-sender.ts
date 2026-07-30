import type { IpcMainInvokeEvent } from 'electron'

import { ApplicationError } from '../../../shared/errors/application-error'
import type { WindowCoordinator, WindowKind } from '../windows/window-coordinator'

export function resolveIpcSenderUrl(event: IpcMainInvokeEvent): string {
  const frameUrl = event.senderFrame?.url
  if (frameUrl === undefined || frameUrl.length === 0) {
    throw new ApplicationError('IPC_SENDER_REJECTED', 'IPC sender frame is unavailable')
  }
  return frameUrl
}

export function verifyIpcSender(
  event: IpcMainInvokeEvent,
  windows: WindowCoordinator,
  kind: WindowKind | readonly WindowKind[],
): void {
  windows.assertSender(event.sender, resolveIpcSenderUrl(event), kind)
}
