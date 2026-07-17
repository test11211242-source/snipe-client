import { ApplicationError } from '../../../shared/errors/application-error'

const MAGIC = Buffer.from('CRT2', 'ascii')
const HEADER_BYTES = 12

export interface BinaryEnvelope<T = unknown> {
  metadata: T
  binary: Buffer
}

export class BinaryEnvelopeStreamDecoder {
  #buffer = Buffer.alloc(0)

  constructor(
    private readonly limits: { maxMetadataBytes: number; maxBinaryBytes: number },
  ) {}

  push(input: Uint8Array): BinaryEnvelope[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(input)])
    const envelopes: BinaryEnvelope[] = []
    while (this.#buffer.byteLength >= HEADER_BYTES) {
      if (!this.#buffer.subarray(0, 4).equals(MAGIC)) {
        throw new ApplicationError(
          'WORKER_RESULT_MALFORMED',
          'Worker result has invalid framing',
        )
      }
      const metadataLength = this.#buffer.readUInt32BE(4)
      const binaryLength = this.#buffer.readUInt32BE(8)
      if (
        metadataLength > this.limits.maxMetadataBytes ||
        binaryLength > this.limits.maxBinaryBytes
      ) {
        throw new ApplicationError(
          'WORKER_RESULT_TOO_LARGE',
          'Worker result exceeds limits',
        )
      }
      const envelopeLength = HEADER_BYTES + metadataLength + binaryLength
      if (this.#buffer.byteLength < envelopeLength) break
      envelopes.push(
        decodeBinaryEnvelope(this.#buffer.subarray(0, envelopeLength), this.limits),
      )
      this.#buffer = this.#buffer.subarray(envelopeLength)
    }
    return envelopes
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) {
      throw new ApplicationError('WORKER_RESULT_TRUNCATED', 'Worker result is truncated')
    }
  }
}

export function encodeBinaryEnvelope(
  metadata: unknown,
  binary: Uint8Array = new Uint8Array(),
): Buffer {
  const binaryBytes = Buffer.from(binary)
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  const header = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(header, 0)
  header.writeUInt32BE(metadataBytes.byteLength, 4)
  header.writeUInt32BE(binaryBytes.byteLength, 8)
  return Buffer.concat([header, metadataBytes, binaryBytes])
}

export function decodeBinaryEnvelope(
  input: Uint8Array,
  limits: { maxMetadataBytes: number; maxBinaryBytes: number },
): BinaryEnvelope {
  const buffer = Buffer.from(input)
  if (buffer.byteLength < HEADER_BYTES || !buffer.subarray(0, 4).equals(MAGIC)) {
    throw new ApplicationError(
      'WORKER_RESULT_MALFORMED',
      'Worker result has invalid framing',
    )
  }
  const metadataLength = buffer.readUInt32BE(4)
  const binaryLength = buffer.readUInt32BE(8)
  if (metadataLength > limits.maxMetadataBytes || binaryLength > limits.maxBinaryBytes) {
    throw new ApplicationError('WORKER_RESULT_TOO_LARGE', 'Worker result exceeds limits')
  }
  if (buffer.byteLength !== HEADER_BYTES + metadataLength + binaryLength) {
    throw new ApplicationError('WORKER_RESULT_TRUNCATED', 'Worker result is truncated')
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(
      buffer.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength).toString('utf8'),
    ) as unknown
  } catch (error) {
    throw new ApplicationError('WORKER_RESULT_MALFORMED', 'Worker metadata is invalid', {
      cause: error,
    })
  }
  return {
    metadata,
    binary: buffer.subarray(HEADER_BYTES + metadataLength),
  }
}
