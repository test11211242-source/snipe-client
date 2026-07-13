import { z } from 'zod'

export const PublicErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict()

export type PublicError = z.infer<typeof PublicErrorSchema>

export class ApplicationError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApplicationError'
    this.code = code
  }

  toPublicError(): PublicError {
    return PublicErrorSchema.parse({ code: this.code, message: this.message })
  }
}
