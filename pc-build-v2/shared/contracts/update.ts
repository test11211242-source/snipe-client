import { z } from 'zod'

import { UpdateViewSchema } from '../models/update'

export const UPDATE_MANIFEST_MAX_BYTES = 128 * 1024
export const UPDATE_ARTIFACT_MAX_BYTES = 500 * 1024 * 1024
export const UPDATE_ORIGIN = 'https://updates.artcsworld.xyz'
export const UPDATE_PATH_PREFIX = '/downloads/v2/'
export const UPDATE_MANIFEST_URL = `${UPDATE_ORIGIN}${UPDATE_PATH_PREFIX}manifest.json`
export const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const StrictSemverSchema = z.string().max(32).regex(STRICT_SEMVER_PATTERN)
const Base64Sha512Schema = z
  .string()
  .max(88)
  .refine((value) => {
    try {
      return (
        Buffer.from(value, 'base64').length === 64 &&
        Buffer.from(value, 'base64').toString('base64') === value
      )
    } catch {
      return false
    }
  }, 'Expected canonical base64 SHA-512')
const Base64SignatureSchema = z
  .string()
  .max(88)
  .refine((value) => {
    try {
      return (
        Buffer.from(value, 'base64').length === 64 &&
        Buffer.from(value, 'base64').toString('base64') === value
      )
    } catch {
      return false
    }
  }, 'Expected canonical base64 Ed25519 signature')

export const UpdateArtifactSchema = z
  .object({
    fileName: z.string().min(1).max(100),
    size: z.number().int().positive().max(UPDATE_ARTIFACT_MAX_BYTES),
    sha512: Base64Sha512Schema,
    url: z.url().max(300),
  })
  .strict()

export const UpdateManifestPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal('stable'),
    version: StrictSemverSchema,
    publishedAt: z.iso.datetime({ offset: true }),
    minimumVersion: StrictSemverSchema.optional(),
    critical: z.boolean(),
    notes: z.array(z.string().min(1).max(1_000)).max(20),
    artifact: UpdateArtifactSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    const expectedFileName = `CR_Tools_V2_Setup_${payload.version}.exe`
    if (payload.artifact.fileName !== expectedFileName) {
      context.addIssue({
        code: 'custom',
        path: ['artifact', 'fileName'],
        message: 'Artifact filename does not match the manifest version',
      })
    }
    let url: URL
    try {
      url = new URL(payload.artifact.url)
    } catch {
      return
    }
    if (
      url.origin !== UPDATE_ORIGIN ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== `${UPDATE_PATH_PREFIX}${expectedFileName}`
    ) {
      context.addIssue({
        code: 'custom',
        path: ['artifact', 'url'],
        message: 'Artifact URL is outside the fixed update location',
      })
    }
  })

export const SignedUpdateManifestSchema = UpdateManifestPayloadSchema.extend({
  signature: Base64SignatureSchema,
}).strict()

export const UPDATE_IPC_CHANNELS = Object.freeze({
  getView: 'update:get-view',
  check: 'update:check',
  download: 'update:download',
  cancel: 'update:cancel',
  install: 'update:install',
})

export const EmptyUpdatePayloadSchema = z.object({}).strict()
export const UpdateViewResultSchema = UpdateViewSchema

export type UpdateManifestPayload = z.infer<typeof UpdateManifestPayloadSchema>
export type SignedUpdateManifest = z.infer<typeof SignedUpdateManifestSchema>
