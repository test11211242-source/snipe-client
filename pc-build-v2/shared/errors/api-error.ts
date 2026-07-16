import { z } from 'zod'

export const ApiErrorCodeSchema = z.enum([
  'NETWORK_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'SERVER_ERROR',
  'SECRET_UNAVAILABLE',
  'SECRET_INVALID',
  'SECRET_CLEAR_FAILED',
  'DEVICE_IDENTITY_UNAVAILABLE',
  'AUTH_CANCELLED',
  'UNKNOWN',
])

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
    status: z.number().int().min(100).max(599).nullable(),
  })
  .strict()

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>
export type ApiError = z.infer<typeof ApiErrorSchema>

export function createApiError(
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
  status: number | null = null,
): ApiError {
  return ApiErrorSchema.parse({ code, message, retryable, status })
}
