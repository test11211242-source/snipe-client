import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { resolveIpcSenderUrl } from './verify-ipc-sender'

function createEvent(
  frameUrl: string | undefined,
  senderUrl: string,
): IpcMainInvokeEvent {
  return {
    sender: { getURL: vi.fn(() => senderUrl) },
    senderFrame: frameUrl === undefined ? undefined : { url: frameUrl },
  } as unknown as IpcMainInvokeEvent
}

describe('resolveIpcSenderUrl', () => {
  it('rejects a missing senderFrame instead of trusting web contents state', () => {
    const event = createEvent(undefined, 'file:///app/auth.html')

    expect(() => resolveIpcSenderUrl(event)).toThrow('IPC sender frame is unavailable')
  })

  it('rejects an empty senderFrame URL', () => {
    expect(() => resolveIpcSenderUrl(createEvent('', 'file:///app/auth.html'))).toThrow(
      'IPC sender frame is unavailable',
    )
  })

  it('does not replace an untrusted frame URL with the trusted top-level URL', () => {
    const event = createEvent('https://attacker.example/frame', 'file:///app/auth.html')

    expect(resolveIpcSenderUrl(event)).toBe('https://attacker.example/frame')
  })
})
