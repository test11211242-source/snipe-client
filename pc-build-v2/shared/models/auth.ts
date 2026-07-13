import { z } from 'zod'

import { ApiErrorSchema } from '../errors/api-error'

export const UserRoleSchema = z.enum(['user', 'premium', 'admin', 'streamer'])

export const AuthUserViewSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    username: z.string().min(1).max(100),
    email: z.email().max(254),
    role: UserRoleSchema,
    roles: z.array(UserRoleSchema).min(1).max(4),
  })
  .strict()

export const AuthStateSchema = z.enum([
  'BOOTSTRAPPING',
  'INVITE_REQUIRED',
  'UNAUTHENTICATED',
  'AUTHENTICATED',
  'BLOCKED',
  'ERROR',
])

export const AuthViewSchema = z
  .object({
    state: AuthStateSchema,
    user: AuthUserViewSchema.nullable(),
    deviceHint: z
      .string()
      .regex(/^[a-f0-9]{8}\.\.\.[a-f0-9]{4}$/)
      .nullable(),
    error: ApiErrorSchema.nullable(),
  })
  .strict()

export type UserRole = z.infer<typeof UserRoleSchema>
export type AuthUserView = z.infer<typeof AuthUserViewSchema>
export type AuthState = z.infer<typeof AuthStateSchema>
export type AuthView = z.infer<typeof AuthViewSchema>

export function hasStreamerRole(view: AuthView | null): boolean {
  return view?.state === 'AUTHENTICATED' && view.user?.roles.includes('streamer') === true
}
