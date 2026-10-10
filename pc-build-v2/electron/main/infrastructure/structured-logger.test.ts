import { describe, expect, it } from 'vitest'

import { StructuredLogger, redactSensitive, type LogRecord } from './structured-logger'

describe('StructuredLogger redaction', () => {
  it('drops unsafe error messages, private fields, binary data and nested URL secrets', () => {
    const context: Record<string, unknown> = {
      error: new Error('password=private https://example.com/?token=private'),
      windowTitle: 'private',
      nickname: 'private',
      email: 'private@example.com',
      nested: [
        'https://example.com/?token=private',
        'Bearer private',
        Buffer.from('private'),
      ],
    }
    context['cycle'] = context
    const serialized = JSON.stringify(redactSensitive(context))
    expect(serialized).not.toContain('private')
    expect(serialized).toContain('[Circular]')
  })

  it('tolerates writer failures and disables debug by default', () => {
    const records: LogRecord[] = []
    const logger = new StructuredLogger((record) => {
      records.push(record)
      throw new Error('disk full')
    })
    expect(() => logger.info('safe')).not.toThrow()
    logger.debug('disabled')
    expect(records).toHaveLength(1)
    logger.setDiagnosticsEnabled(true)
    logger.debug('enabled')
    expect(records).toHaveLength(2)
  })
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
