import { describe, expect, it } from 'vitest'

import { StructuredLogger, redactSensitive, type LogRecord } from './structured-logger'

describe('StructuredLogger redaction', () => {
  it('redacts sensitive keys recursively without changing safe fields', () => {
    const value = redactSensitive({
      token: 'secret',
      nested: {
        Authorization: 'Bearer secret',
        refresh_token: 'refresh-secret',
        HWID: 'machine-id',
        image_b64: 'large-image',
        status: 'ready',
      },
    })

    expect(value).toEqual({
      token: '[REDACTED]',
      nested: {
        Authorization: '[REDACTED]',
        refresh_token: '[REDACTED]',
        HWID: '[REDACTED]',
        image_b64: '[REDACTED]',
        status: 'ready',
      },
    })
  })

  it('redacts context before passing a record to the writer', () => {
    const records: LogRecord[] = []
    const logger = new StructuredLogger((record) => records.push(record))

    logger.info('request completed', { accessToken: 'secret', requestId: 'req-1' })

    expect(records).toHaveLength(1)
    expect(records[0]?.context).toEqual({
      accessToken: '[REDACTED]',
      requestId: 'req-1',
    })
  })
})
