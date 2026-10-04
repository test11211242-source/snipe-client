import { describe, expect, it } from 'vitest'

import {
  AuthViewResultSchema,
  LoginPayloadSchema,
  RegisterPayloadSchema,
} from './auth-ipc'
import { ServerUserSchema, toAuthUserView, RegisterRequestSchema } from './server'
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
        error: null,
      }),
    ).toBe(true)
    expect(toAuthUserView({ ...user, roles: undefined }).roles).toEqual(['premium'])
  })

  it('requires and trims the registration key at both IPC and server boundaries', () => {
    const payload = {
      email: 'a@example.com',
      username: 'tester',
      password: 'password123',
    }
    const request = { ...payload, hwid: 'a'.repeat(64) }
    expect(RegisterPayloadSchema.safeParse(payload).success).toBe(false)
    expect(RegisterRequestSchema.safeParse(request).success).toBe(false)
    expect(
      RegisterPayloadSchema.parse({ ...payload, inviteKey: ' test_key-123 ' }).inviteKey,
    ).toBe('test_key-123')
    expect(
      RegisterRequestSchema.parse({ ...request, invite_key: ' test_key-123 ' })
        .invite_key,
    ).toBe('test_key-123')
    for (const key of ['', 'short', 'a'.repeat(51), 'invalid key', 'key<script>']) {
      expect(
        RegisterPayloadSchema.safeParse({ ...payload, inviteKey: key }).success,
      ).toBe(false)
      expect(
        RegisterRequestSchema.safeParse({ ...request, invite_key: key }).success,
      ).toBe(false)
    }
    for (const key of ['a'.repeat(8), 'a'.repeat(50)]) {
      expect(
        RegisterPayloadSchema.safeParse({ ...payload, inviteKey: key }).success,
      ).toBe(true)
      expect(
        RegisterRequestSchema.safeParse({ ...request, invite_key: key }).success,
      ).toBe(true)
    }
    expect(
      RegisterPayloadSchema.safeParse({
        ...payload,
        inviteKey: 'test_key-123',
        hwid: 'renderer-device',
      }).success,
    ).toBe(false)
  })
})
