import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

import { ApplicationError } from '../../../shared/errors/application-error'

export interface WorkerChild extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill: (signal?: NodeJS.Signals) => boolean
  pid?: number
}

export type WorkerSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => WorkerChild

export interface PythonWorkerRequest {
  requestId?: string
  executable: string
  scriptPath: string
  input: Uint8Array
  timeoutMs: number
  signal?: AbortSignal
}

export interface PythonWorkerResult {
  requestId: string
  stdout: Buffer
  stderr: Buffer
}

export type ProcessTreeKiller = (child: WorkerChild) => Promise<void>
type KillCommandSpawn = typeof nodeSpawn

interface QueuedRequest {
  request: PythonWorkerRequest
  resolve: (value: PythonWorkerResult) => void
  reject: (reason: unknown) => void
  pendingAbort?: () => void
}

const defaultSpawn: WorkerSpawn = (executable, args, options) =>
  nodeSpawn(executable, [...args], options) as unknown as WorkerChild

const KILLER_TIMEOUT_MS = 2_000
const TASKKILL_TIMEOUT_MS = 1_000

export function createDefaultTreeKiller(
  spawnCommand: KillCommandSpawn = nodeSpawn,
  platform = process.platform,
): ProcessTreeKiller {
  return async (child) => {
    if (platform !== 'win32' || child.pid === undefined) {
      child.kill('SIGKILL')
      return
    }
    const killed = await new Promise<boolean>((resolve) => {
      let settled = false
      let killer: ReturnType<KillCommandSpawn> | undefined
      const finish = (success: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolve(success)
      }
      const deadline = setTimeout(() => {
        try {
          killer?.kill('SIGKILL')
        } catch {
          // The root fallback below remains authoritative.
        }
        finish(false)
      }, TASKKILL_TIMEOUT_MS)
      try {
        killer = spawnCommand('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('close', (code) => finish(code === 0))
        killer.once('error', () => finish(false))
      } catch {
        finish(false)
      }
    })
    if (!killed) child.kill('SIGKILL')
  }
}

const defaultTreeKiller = createDefaultTreeKiller()

export class PythonWorkerService {
  #active = false
  readonly #queue: QueuedRequest[] = []

  constructor(
    private readonly spawn: WorkerSpawn = defaultSpawn,
    private readonly killTree: ProcessTreeKiller = defaultTreeKiller,
    private readonly limits = {
      maxQueue: 8,
      maxStdinBytes: 40 * 1024 * 1024,
      maxStdoutBytes: 40 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    },
    private readonly beforeSpawn?: () => Promise<void>,
  ) {}

  execute(request: PythonWorkerRequest): Promise<PythonWorkerResult> {
    if (request.input.byteLength > this.limits.maxStdinBytes) {
      return Promise.reject(
        new ApplicationError(
          'WORKER_INPUT_TOO_LARGE',
          'Python worker input exceeds limit',
        ),
      )
    }
    if (request.timeoutMs <= 0 || !Number.isFinite(request.timeoutMs)) {
      return Promise.reject(
        new ApplicationError(
          'WORKER_REQUEST_INVALID',
          'Python worker timeout is invalid',
        ),
      )
    }
    if (this.#queue.length >= this.limits.maxQueue) {
      return Promise.reject(
        new ApplicationError('WORKER_QUEUE_FULL', 'Python worker queue is full'),
      )
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(
        new ApplicationError('WORKER_ABORTED', 'Python worker was aborted'),
      )
    }

    return new Promise((resolve, reject) => {
      const queued: QueuedRequest = { request, resolve, reject }
      if (request.signal !== undefined) {
        queued.pendingAbort = () => {
          const index = this.#queue.indexOf(queued)
          if (index >= 0) {
            this.#queue.splice(index, 1)
            reject(new ApplicationError('WORKER_ABORTED', 'Python worker was aborted'))
          }
        }
        request.signal.addEventListener('abort', queued.pendingAbort, { once: true })
      }
      this.#queue.push(queued)
      this.pump()
    })
  }

  private pump(): void {
    if (this.#active) return
    const queued = this.#queue.shift()
    if (queued === undefined) return
    this.#active = true
    if (queued.pendingAbort !== undefined) {
      queued.request.signal?.removeEventListener('abort', queued.pendingAbort)
    }
    void this.run(queued.request)
      .then(queued.resolve, queued.reject)
      .finally(() => {
        this.#active = false
        this.pump()
      })
  }

  private run(request: PythonWorkerRequest): Promise<PythonWorkerResult> {
    if (this.beforeSpawn === undefined) return this.runChild(request)
    return this.beforeSpawn().then(() => this.runChild(request))
  }

  private runChild(request: PythonWorkerRequest): Promise<PythonWorkerResult> {
    return new Promise((resolve, reject) => {
      const requestId = request.requestId ?? randomUUID()
      const child = this.spawn(request.executable, [request.scriptPath], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CR_TOOLS_REQUEST_ID: requestId },
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let terminationError: ApplicationError | undefined

      const cleanup = (): void => {
        clearTimeout(timeout)
        request.signal?.removeEventListener('abort', abort)
        child.stdout.removeAllListeners()
        child.stderr.removeAllListeners()
        child.removeAllListeners()
      }
      const finish = (error: ApplicationError | undefined = terminationError): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined) reject(error)
        else
          resolve({
            requestId,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          })
      }
      const terminate = (error: ApplicationError): void => {
        if (settled || terminationError !== undefined) return
        terminationError = error
        clearTimeout(timeout)
        void this.killChildBounded(child).finally(() => finish(error))
      }
      const abort = (): void =>
        terminate(new ApplicationError('WORKER_ABORTED', 'Python worker was aborted'))
      const timeout = setTimeout(
        () =>
          terminate(new ApplicationError('WORKER_TIMEOUT', 'Python worker timed out')),
        request.timeoutMs,
      )

      request.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.from(chunk)
        stdoutBytes += bytes.byteLength
        if (stdoutBytes > this.limits.maxStdoutBytes) {
          terminate(
            new ApplicationError(
              'WORKER_OUTPUT_TOO_LARGE',
              'Python worker output exceeds limit',
            ),
          )
        } else stdout.push(bytes)
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.from(chunk)
        stderrBytes += bytes.byteLength
        if (stderrBytes > this.limits.maxStderrBytes) {
          terminate(
            new ApplicationError(
              'WORKER_STDERR_TOO_LARGE',
              'Python worker stderr exceeds limit',
            ),
          )
        } else stderr.push(bytes)
      })
      child.once('error', () =>
        finish(
          new ApplicationError('WORKER_START_FAILED', 'Python worker failed to start'),
        ),
      )
      child.once('close', (code: number | null) => {
        if (code === 0) finish()
        else
          finish(
            new ApplicationError('WORKER_FAILED', 'Python worker exited unsuccessfully'),
          )
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(Buffer.from(request.input))
    })
  }

  private killChildBounded(child: WorkerChild): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (fallback: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        if (fallback) child.kill('SIGKILL')
        resolve()
      }
      const deadline = setTimeout(() => finish(true), KILLER_TIMEOUT_MS)
      void Promise.resolve()
        .then(() => this.killTree(child))
        .then(
          () => finish(false),
          () => finish(true),
        )
    })
  }
}
