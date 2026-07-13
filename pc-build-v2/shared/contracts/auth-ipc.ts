import { z } from 'zod'

import { AuthViewSchema } from '../models/auth'
import { RealtimeStatusSchema } from '../models/network'

export const AUTH_IPC_CHANNELS = Object.freeze({
  getView: 'auth:get-view',
  retryBootstrap: 'auth:retry-bootstrap',
  checkInvite: 'auth:check-invite',
  activateInvite: 'auth:activate-invite',
  login: 'auth:login',
  register: 'auth:register',
})

export const MAIN_NETWORK_IPC_CHANNELS = Object.freeze({
  getAuthView: 'main:get-auth-view',
  logout: 'main:logout',
  getRealtimeStatus: 'main:get-realtime-status',
})

export const EmptyPayloadSchema = z.object({}).strict()
export const AuthViewResultSchema = AuthViewSchema
export const RealtimeStatusResultSchema = RealtimeStatusSchema

export const ActivateInvitePayloadSchema = z
  .object({
    inviteCode: z
      .string()
      .trim()
      .min(8)
      .max(50)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()
export const LoginPayloadSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(256),
  })
  .strict()
export const RegisterPayloadSchema = z
  .object({
    email: z.email().max(254),
    username: z.string().trim().min(2).max(50),
    password: z.string().min(8).max(256),
  })
  .strict()

export type ActivateInvitePayload = z.infer<typeof ActivateInvitePayloadSchema>
export type LoginPayload = z.infer<typeof LoginPayloadSchema>
export type RegisterPayload = z.infer<typeof RegisterPayloadSchema>
