export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  timestamp: string
  level: LogLevel
  message: string
  context?: unknown
}

export type LogWriter = (record: LogRecord) => void

const SENSITIVE_KEY =
  /token|authorization|refresh|hwid|image_?b64|imagebase64|base64|password|secret|invite|title|nickname|alias|email|account|body|payload|stack|message|description|url|screenshot|^image$|^crop$/i
const REDACTED = '[REDACTED]'

export function redactSensitive(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth > 8) return '[Depth limit]'
  if (typeof value === 'string') return REDACTED
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[BINARY]'
  if (value instanceof Error) {
    return {
      name: /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(value.name) ? value.name : 'Error',
      code:
        'code' in value &&
        typeof value.code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
          ? value.code
          : 'UNKNOWN',
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.slice(0, 50).map((item) => redactSensitive(item, seen, depth + 1))
  }

  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [
          key.slice(0, 80),
          SENSITIVE_KEY.test(key)
            ? REDACTED
            : typeof item === 'string' &&
                /^(code|state|status|stage|capability|method|kind|channel|profile|reason|errorClass|requestId|version|lifecycle|searchMode|deckMode|endpoint|path)$/.test(
                  key,
                ) &&
                /^[A-Za-z0-9_:/.-]{1,120}$/.test(item) &&
                !item.includes('?') &&
                !item.includes('@')
              ? item
              : redactSensitive(item, seen, depth + 1),
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

  constructor(
    private readonly writer: LogWriter = defaultWriter,
    private readonly diagnostics?: {
      flush: () => Promise<void>
      openFolder: () => Promise<boolean>
    },
  ) {}

  async flush(): Promise<void> {
    await this.diagnostics?.flush()
  }

  async openFolder(): Promise<boolean> {
    return this.diagnostics === undefined ? false : this.diagnostics.openFolder()
  }

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
      message: message
        .slice(0, 500)
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
        .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[EMAIL]')
        .replace(
          /(?:bearer\s+|(?:token|password|secret|invite|hwid|title|nickname)\s*[:=]\s*)[^\s,;]+/gi,
          REDACTED,
        )
        .replace(/[A-Za-z0-9+/=_-]{64,}/g, '[BINARY]'),
    }
    try {
      if (context !== undefined) record.context = redactSensitive(context)
      this.writer(record)
    } catch {
      // Diagnostics must not interrupt capture, IPC or shutdown.
    }
  }
}
