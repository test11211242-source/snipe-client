export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  timestamp: string
  level: LogLevel
  message: string
  context?: unknown
}

export type LogWriter = (record: LogRecord) => void

const SENSITIVE_KEY =
  /token|authorization|refresh|hwid|image_?b64|imagebase64|base64image/i
const REDACTED = '[REDACTED]'

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.map((item) => redactSensitive(item, seen))
  }

  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(item, seen),
      ]),
    )
  }

  return value
}

function defaultWriter(record: LogRecord): void {
  const line = JSON.stringify(record)
  if (record.level === 'error') {
    console.error(line)
  } else if (record.level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export class StructuredLogger {
  #diagnosticsEnabled = false

  constructor(private readonly writer: LogWriter = defaultWriter) {}

  setDiagnosticsEnabled(enabled: boolean): void {
    this.#diagnosticsEnabled = enabled
  }

  debug(message: string, context?: unknown): void {
    this.write('debug', message, context)
  }

  info(message: string, context?: unknown): void {
    this.write('info', message, context)
  }

  warn(message: string, context?: unknown): void {
    this.write('warn', message, context)
  }

  error(message: string, context?: unknown): void {
    this.write('error', message, context)
  }

  private write(level: LogLevel, message: string, context?: unknown): void {
    if (level === 'debug' && !this.#diagnosticsEnabled) return
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
    }
    if (context !== undefined) record.context = redactSensitive(context)
    this.writer(record)
  }
}
