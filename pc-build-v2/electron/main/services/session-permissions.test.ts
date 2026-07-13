import type { Session } from 'electron'

import { describe, expect, it, vi } from 'vitest'

import { installDenyAllSessionPermissions } from './session-permissions'

type CheckHandler = Exclude<Parameters<Session['setPermissionCheckHandler']>[0], null>
type RequestHandler = Exclude<Parameters<Session['setPermissionRequestHandler']>[0], null>
type DisplayHandler = Exclude<
  Parameters<Session['setDisplayMediaRequestHandler']>[0],
  null
>

describe('installDenyAllSessionPermissions', () => {
  it('denies checks, requests, and display media by default', () => {
    const checkHandlers: CheckHandler[] = []
    const requestHandlers: RequestHandler[] = []
    const displayHandlers: DisplayHandler[] = []
    const session = {
      setPermissionCheckHandler: vi.fn((handler: CheckHandler) => {
        checkHandlers.push(handler)
      }),
      setPermissionRequestHandler: vi.fn((handler: RequestHandler) => {
        requestHandlers.push(handler)
      }),
      setDisplayMediaRequestHandler: vi.fn((handler: DisplayHandler) => {
        displayHandlers.push(handler)
      }),
    }
    installDenyAllSessionPermissions(session as unknown as Session)

    const checkHandler = checkHandlers[0]
    const requestHandler = requestHandlers[0]
    const displayHandler = displayHandlers[0]
    if (
      checkHandler === undefined ||
      requestHandler === undefined ||
      displayHandler === undefined
    ) {
      throw new Error('Permission handler was not installed')
    }
    expect(checkHandler(null, 'clipboard-read', 'file:///', undefined as never)).toBe(
      false,
    )
    const permissionCallback = vi.fn()
    requestHandler(
      undefined as never,
      'clipboard-read',
      permissionCallback,
      undefined as never,
    )
    expect(permissionCallback).toHaveBeenCalledWith(false)
    const displayCallback = vi.fn()
    displayHandler(undefined as never, displayCallback)
    expect(displayCallback).toHaveBeenCalledWith({})
  })
})
