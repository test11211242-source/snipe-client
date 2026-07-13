import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  createDefaultTreeKiller,
  PythonWorkerService,
  type WorkerChild,
  type WorkerSpawn,
} from './python-worker-service'

class FakeChild extends EventEmitter implements WorkerChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 123
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test value')
  return value
}

function workerWith(
  children: FakeChild[],
  limits?: ConstructorParameters<typeof PythonWorkerService>[2],
) {
  const spawn: WorkerSpawn = (_executable, _args, options) => {
    expect(options.shell).toBe(false)
    const child = new FakeChild()
    children.push(child)
    return child
  }
  return new PythonWorkerService(
    spawn,
    (child) => {
      child.kill('SIGKILL')
      return Promise.resolve()
    },
    limits,
  )
}

const request = {
  executable: 'python',
  scriptPath: 'worker.py',
  input: new Uint8Array(),
  timeoutMs: 100,
}

describe('PythonWorkerService', () => {
  it('kills timed out and aborted children deterministically', async () => {
    vi.useFakeTimers()
    const children: FakeChild[] = []
    const worker = workerWith(children)
    const timedOut = worker.execute(request)
    const timedOutAssertion = expect(timedOut).rejects.toMatchObject({
      code: 'WORKER_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(100)
    await timedOutAssertion
    expect(children[0]?.killed).toBe(true)

    const controller = new AbortController()
    const aborted = worker.execute({ ...request, signal: controller.signal })
    const abortedAssertion = expect(aborted).rejects.toMatchObject({
      code: 'WORKER_ABORTED',
    })
    controller.abort()
    await abortedAssertion
    expect(children[1]?.killed).toBe(true)
    vi.useRealTimers()
  })

  it('bounds stdout and ignores stale completion after overflow', async () => {
    const children: FakeChild[] = []
    const worker = workerWith(children, {
      maxQueue: 2,
      maxStdinBytes: 10,
      maxStdoutBytes: 3,
      maxStderrBytes: 3,
    })
    const result = worker.execute(request)
    required(children[0]).stdout.write('four')
    await expect(result).rejects.toMatchObject({ code: 'WORKER_OUTPUT_TOO_LARGE' })
    required(children[0]).emit('close', 0)
    expect(children[0]?.killed).toBe(true)
  })

  it('serializes requests through a one-worker queue', async () => {
    const children: FakeChild[] = []
    const worker = workerWith(children)
    const first = worker.execute(request)
    const second = worker.execute(request)
    expect(children).toHaveLength(1)
    required(children[0]).stdout.end('one')
    required(children[0]).emit('close', 0)
    await expect(first).resolves.toMatchObject({ stdout: Buffer.from('one') })
    await vi.waitFor(() => expect(children).toHaveLength(2))
    required(children[1]).emit('close', 0)
    await expect(second).resolves.toBeDefined()
  })

  it('settles ownership and falls back when an injected killer never resolves', async () => {
    vi.useFakeTimers()
    const children: FakeChild[] = []
    const worker = new PythonWorkerService(
      () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
      () => new Promise(() => undefined),
    )
    const timedOut = worker.execute({ ...request, timeoutMs: 10 })
    const expectation = expect(timedOut).rejects.toMatchObject({ code: 'WORKER_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(2_010)
    await expectation
    expect(children[0]?.killed).toBe(true)
    vi.useRealTimers()
  })

  it('inspects a nonzero taskkill exit and falls back to the root child', async () => {
    const child = new FakeChild()
    const killerProcess = new EventEmitter()
    const spawnCommand = vi.fn(() => killerProcess)
    const killing = createDefaultTreeKiller(
      spawnCommand as unknown as Parameters<typeof createDefaultTreeKiller>[0],
      'win32',
    )(child)
    killerProcess.emit('close', 1)
    await killing
    expect(spawnCommand).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/pid', '123', '/t', '/f'],
      expect.objectContaining({ shell: false }),
    )
    expect(child.killed).toBe(true)
  })
})
