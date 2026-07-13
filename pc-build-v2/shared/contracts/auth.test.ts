import { describe, expect, it } from 'vitest'

import { AuthViewResultSchema, LoginPayloadSchema } from './auth-ipc'
import { ServerUserSchema, toAuthUserView } from './server'
import { hasStreamerRole } from '../models/auth'

describe('auth boundary contracts', () => {
  it('accepts server user extensions but projects a strict minimal renderer user', () => {
    const serverUser = ServerUserSchema.parse({
      id: 42,
      username: 'operator',
      email: 'operator@example.com',
      role: 'streamer',
      roles: ['streamer'],
      access_token: 'must-not-cross',
    })
    expect(toAuthUserView(serverUser)).toEqual({
      id: '42',
      username: 'operator',
      email: 'operator@example.com',
      role: 'streamer',
      roles: ['streamer'],
    })
    expect(() =>
      AuthViewResultSchema.parse({
        state: 'AUTHENTICATED',
        user: toAuthUserView(serverUser),
        deviceHint: '12345678...abcd',
        error: null,
        token: 'rejected',
      }),
    ).toThrow()
  })

  it('rejects unknown IPC fields and unsupported server roles', () => {
    expect(() =>
      LoginPayloadSchema.parse({ email: 'a@example.com', password: 'x', hwid: 'hidden' }),
    ).toThrow()
    expect(() =>
      ServerUserSchema.parse({
        id: 1,
        username: 'x',
        email: 'a@example.com',
        role: 'moderator',
      }),
    ).toThrow()
  })

  it('deduplicates authoritative roles and gates streamer access by roles, not primary role', () => {
    const user = toAuthUserView({
      id: 7,
      username: 'caster',
      email: 'caster@example.com',
      role: 'premium',
      roles: ['premium', 'streamer', 'streamer'],
    })
    expect(user.roles).toEqual(['premium', 'streamer'])
    expect(
      hasStreamerRole({
        state: 'AUTHENTICATED',
        user,
        deviceHint: null,
        error: null,
      }),
    ).toBe(true)
    expect(toAuthUserView({ ...user, roles: undefined }).roles).toEqual(['premium'])
  })
})
