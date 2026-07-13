import { verify as nodeVerify } from 'node:crypto'

import {
  SignedUpdateManifestSchema,
  UPDATE_MANIFEST_MAX_BYTES,
  type SignedUpdateManifest,
  type UpdateManifestPayload,
} from '../../../shared/contracts/update'
import { canonicalizeUpdatePayload } from '../../../shared/update-manifest.mjs'

export class UpdateValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'UpdateValidationError'
  }
}

class StrictJsonParser {
  #offset = 0

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.#offset !== this.source.length) this.fail('Unexpected trailing JSON data')
    return value
  }

  private parseValue(): unknown {
    this.skipWhitespace()
    const character = this.source[this.#offset]
    if (character === '{') return this.parseObject()
    if (character === '[') return this.parseArray()
    if (character === '"') return this.parseString()
    if (character === 't') return this.parseLiteral('true', true)
    if (character === 'f') return this.parseLiteral('false', false)
    if (character === 'n') return this.parseLiteral('null', null)
    return this.parseNumber()
  }

  private parseObject(): Record<string, unknown> {
    this.#offset += 1
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const keys = new Set<string>()
    this.skipWhitespace()
    if (this.source[this.#offset] === '}') {
      this.#offset += 1
      return value
    }
    for (;;) {
      this.skipWhitespace()
      if (this.source[this.#offset] !== '"') this.fail('Expected an object key')
      const key = this.parseString()
      if (keys.has(key)) this.fail('Duplicate JSON object key')
      keys.add(key)
      this.skipWhitespace()
      if (this.source[this.#offset] !== ':') this.fail('Expected a colon')
      this.#offset += 1
      value[key] = this.parseValue()
      this.skipWhitespace()
      const separator = this.source[this.#offset]
      this.#offset += 1
      if (separator === '}') return value
      if (separator !== ',') this.fail('Expected a comma or closing brace')
    }
  }

  private parseArray(): unknown[] {
    this.#offset += 1
    const value: unknown[] = []
    this.skipWhitespace()
    if (this.source[this.#offset] === ']') {
      this.#offset += 1
      return value
    }
    for (;;) {
      value.push(this.parseValue())
      this.skipWhitespace()
      const separator = this.source[this.#offset]
      this.#offset += 1
      if (separator === ']') return value
      if (separator !== ',') this.fail('Expected a comma or closing bracket')
    }
  }

  private parseString(): string {
    const start = this.#offset
    this.#offset += 1
    let escaped = false
    while (this.#offset < this.source.length) {
      const character = this.source.charAt(this.#offset)
      if (!escaped && character === '"') {
        this.#offset += 1
        try {
          return JSON.parse(this.source.slice(start, this.#offset)) as string
        } catch {
          this.fail('Invalid JSON string')
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20)
        this.fail('Control character in string')
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      this.#offset += 1
    }
    this.fail('Unterminated JSON string')
  }

  private parseLiteral<T>(token: string, value: T): T {
    if (!this.source.startsWith(token, this.#offset)) this.fail('Invalid JSON literal')
    this.#offset += token.length
    return value
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.#offset),
    )
    if (match === null) this.fail('Invalid JSON value')
    this.#offset += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) this.fail('Non-finite JSON number')
    return value
  }

  private skipWhitespace(): void {
    while ([' ', '\t', '\r', '\n'].includes(this.source[this.#offset] ?? '')) {
      this.#offset += 1
    }
  }

  private fail(message: string): never {
    throw new UpdateValidationError('MANIFEST_INVALID', message)
  }
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export function parseStrictJson(source: string): unknown {
  return new StrictJsonParser(source).parse()
}

export function manifestPayload(manifest: SignedUpdateManifest): UpdateManifestPayload {
  return {
    schemaVersion: manifest.schemaVersion,
    channel: manifest.channel,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    ...(manifest.minimumVersion === undefined
      ? {}
      : { minimumVersion: manifest.minimumVersion }),
    critical: manifest.critical,
    notes: manifest.notes,
    artifact: manifest.artifact,
  }
}

export function verifyUpdateManifest(
  bytes: Uint8Array,
  publicKey: string,
  currentVersion: string,
  verify: typeof nodeVerify = nodeVerify,
): { manifest: SignedUpdateManifest; updateAvailable: boolean } {
  if (bytes.byteLength > UPDATE_MANIFEST_MAX_BYTES) {
    throw new UpdateValidationError('MANIFEST_TOO_LARGE', 'Update metadata is too large')
  }

  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new UpdateValidationError(
      'MANIFEST_INVALID',
      'Update metadata is not valid UTF-8',
    )
  }

  const parsed = parseStrictJson(source)
  const result = SignedUpdateManifestSchema.safeParse(parsed)
  if (!result.success) {
    throw new UpdateValidationError('MANIFEST_INVALID', 'Update metadata is invalid')
  }
  const manifest = result.data
  const payload = manifestPayload(manifest)
  const validSignature = verify(
    null,
    Buffer.from(canonicalizeUpdatePayload(payload), 'utf8'),
    publicKey,
    Buffer.from(manifest.signature, 'base64'),
  )
  if (!validSignature) {
    throw new UpdateValidationError(
      'MANIFEST_UNTRUSTED',
      'Update metadata could not be verified',
    )
  }
  if (
    manifest.minimumVersion !== undefined &&
    compareSemver(currentVersion, manifest.minimumVersion) < 0
  ) {
    throw new UpdateValidationError(
      'MINIMUM_VERSION_UNSUPPORTED',
      'This version cannot install the available update automatically',
    )
  }
  return {
    manifest,
    updateAvailable: compareSemver(manifest.version, currentVersion) > 0,
  }
}
