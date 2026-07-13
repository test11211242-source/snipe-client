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
  it('falls back to the registered web contents URL when senderFrame is missing', () => {
    const event = createEvent(undefined, 'file:///app/auth.html')

    expect(resolveIpcSenderUrl(event)).toBe('file:///app/auth.html')
  })

  it('falls back to the registered web contents URL when senderFrame URL is empty', () => {
    expect(resolveIpcSenderUrl(createEvent('', 'file:///app/auth.html'))).toBe(
      'file:///app/auth.html',
    )
  })

  it('does not replace an untrusted frame URL with the trusted top-level URL', () => {
    const event = createEvent('https://attacker.example/frame', 'file:///app/auth.html')

    expect(resolveIpcSenderUrl(event)).toBe('https://attacker.example/frame')
  })
})
