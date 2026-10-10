import { describe, expect, it } from 'vitest'

import { StructuredLogger, redactSensitive, type LogRecord } from './structured-logger'

describe('StructuredLogger redaction', () => {
  it('allows only API endpoints rather than filesystem paths', () => {
    expect(
      redactSensitive({ path: 'C:/Users/private/data', endpoint: '/home/private/file' }),
    ).toEqual({ path: '[REDACTED]', endpoint: '[REDACTED]' })
    expect(
      redactSensitive({ path: '/api/auth/me', endpoint: '/api/ocr/process' }),
    ).toEqual({ path: '/api/auth/me', endpoint: '/api/ocr/process' })
  })

  it('counts failed writer calls and emits a safe recovery summary', () => {
    let denied = true
    const records: LogRecord[] = []
    const logger = new StructuredLogger((record) => {
      if (denied) throw new Error('private failure')
      records.push(record)
    })
    logger.warn('safe')
    expect(logger.failedRecords).toBe(1)
    denied = false
    logger.info('recovered')
    expect(records[0]).toMatchObject({
      message: 'Diagnostic writer failures',
      context: { failedRecords: 1 },
    })
    expect(records[1]?.message).toBe('recovered')
  })
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
