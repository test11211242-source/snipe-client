import { z } from 'zod'

import { UserRoleSchema, type AuthUserView } from '../models/auth'

export const InviteCheckRequestSchema = z
  .object({ hwid: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
export const InviteActivateRequestSchema = z
  .object({
    invite_code: z
      .string()
      .trim()
      .min(8)
      .max(50)
      .regex(/^[A-Za-z0-9_-]+$/),
    hwid: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const LoginRequestSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(256),
    hwid: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const RegisterRequestSchema = z
  .object({
    email: z.email().max(254),
    username: z.string().trim().min(2).max(50),
    password: z.string().min(8).max(256),
    hwid: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const RefreshRequestSchema = z
  .object({ refresh_token: z.string().min(1).max(8192) })
  .strict()
export const LogoutRequestSchema = z
  .object({ refresh_token: z.string().min(1).max(16_384) })
  .strict()
export const ServerLogoutResponseSchema = z.object({ success: z.literal(true) }).loose()

export const ServerUserSchema = z
  .object({
    id: z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]),
    username: z.string().min(1).max(100),
    email: z.email().max(254),
    role: UserRoleSchema,
    roles: z.array(UserRoleSchema).max(16).optional(),
  })
  .loose()

export const ServerTokensSchema = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().min(1).max(16_384).optional(),
  })
  .loose()

export const ServerAuthResponseSchema = z
  .object({
    success: z.boolean().optional(),
    tokens: ServerTokensSchema.optional(),
    user: ServerUserSchema.optional(),
  })
  .loose()

export const ServerMeResponseSchema = z.union([
  ServerUserSchema,
  z.object({ user: ServerUserSchema }).loose(),
])

export const ServerInviteCheckResponseSchema = z
  .object({
    success: z.boolean().optional(),
    has_access: z.boolean(),
    message: z.string().max(300).optional(),
    key_info: z.unknown().optional(),
  })
  .loose()

export const ServerInviteActivateResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string().max(300).optional(),
    error_code: z.string().max(100).optional(),
    key_info: z.unknown().optional(),
  })
  .loose()

export type ServerTokens = z.infer<typeof ServerTokensSchema>

export function toAuthUserView(input: unknown): AuthUserView {
  const user = ServerUserSchema.parse(input)
  const roles = [
    ...new Set(
      user.roles !== undefined && user.roles.length > 0 ? user.roles : [user.role],
    ),
  ]
  return {
    id: String(user.id),
    username: user.username,
    email: user.email,
    role: user.role,
    roles,
  }
}

export function parseMeUser(input: unknown): AuthUserView {
  const parsed = ServerMeResponseSchema.parse(input)
  return toAuthUserView('user' in parsed ? parsed.user : parsed)
}
