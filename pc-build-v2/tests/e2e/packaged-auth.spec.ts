import { chromium, expect, test, type Browser } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

test.skip(process.platform !== 'win32', 'Packaged Electron smoke runs on Windows only')

const executeFile = promisify(execFile)
const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'CR Tools V2.exe')
const resources = join(process.cwd(), 'release', 'win-unpacked', 'resources')

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
  if (address === null || typeof address === 'string') {
    throw new Error('Could not reserve a loopback debugging port')
  }
  return address.port
}

function captureProcessOutput(child: ChildProcess): () => string {
  let output = ''
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-16_384)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('error', (error) => {
    output = `${output}\n${error.stack ?? error.message}`.slice(-16_384)
  })
  return () => output
}

async function waitForDevTools(
  child: ChildProcess,
  port: number,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  const endpoint = `http://127.0.0.1:${port}/json/version`
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged Electron exited before CDP was ready:\n${output()}`)
    }
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) })
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) return
    } catch {
      // The local endpoint is expected to refuse connections during Chromium startup.
    }
    await delay(250)
  }
  throw new Error(`Packaged Electron did not expose CDP within 30 seconds:\n${output()}`)
}

async function waitForCleanExit(
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  if (child.exitCode !== null) {
    expect(child.exitCode, output()).toBe(0)
    return
  }
  const result = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Packaged Electron did not exit cleanly:\n${output()}`)),
      15_000,
    )
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  expect(result, output()).toEqual({ code: 0, signal: null })
}

test('packaged portable runtime contains the pinned capture stack', async () => {
  test.setTimeout(45_000)

  const python = join(resources, 'python-runtime', 'python.exe')
  await Promise.all([
    access(python),
    access(join(resources, 'python', 'capture_once.py')),
    access(join(resources, 'python', 'monitor_engine.py')),
    access(join(resources, 'runtime-integrity.json')),
  ])
  const inventory = JSON.parse(
    await readFile(join(resources, 'runtime-integrity.json'), 'utf8'),
  ) as { root?: unknown; files?: unknown[] }
  expect(inventory.root).toBe('python-runtime')
  expect(inventory.files?.length).toBeGreaterThan(0)
  await expect(
    executeFile(
      python,
      ['-c', "import cv2, numpy, windows_capture; print('bundled imports verified')"],
      { windowsHide: true, timeout: 30_000 },
    ),
  ).resolves.toMatchObject({
    stdout: expect.stringContaining('bundled imports verified'),
  })
})

test('packaged app opens an isolated auth window and exits cleanly', async () => {
  test.setTimeout(90_000)

  const userDataDirectory = await mkdtemp(join(tmpdir(), 'cr-tools-v2-e2e-'))
  const port = await reserveLoopbackPort()
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    const environment = { ...process.env }
    delete environment['ELECTRON_RUN_AS_NODE']
    child = spawn(
      executablePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDirectory}`,
        '--enable-logging=stderr',
      ],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const processOutput = captureProcessOutput(child)
    await waitForDevTools(child, port, processOutput)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const pageCount = (): number =>
      browser?.contexts().reduce((count, context) => count + context.pages().length, 0) ??
      0
    await expect.poll(pageCount, { timeout: 15_000 }).toBeGreaterThan(0)
    const page = browser.contexts().flatMap((context) => context.pages())[0]
    if (page === undefined) throw new Error('Packaged Electron did not create a page')

    await expect(page).toHaveTitle(/CR Tools V2/)
    await expect.poll(() => page.evaluate(() => typeof window.crToolsAuth)).toBe('object')
    expect(
      await page.evaluate(() => ({
        nodeRequire: typeof (globalThis as { require?: unknown }).require,
        nodeProcess: typeof (globalThis as { process?: unknown }).process,
        authApiFrozen: Object.isFrozen(window.crToolsAuth),
        mainApi: typeof (window as unknown as { crTools?: unknown }).crTools,
      })),
    ).toEqual({
      nodeRequire: 'undefined',
      nodeProcess: 'undefined',
      authApiFrozen: true,
      mainApi: 'undefined',
    })

    const pagesBefore = pageCount()
    await page.evaluate(() => {
      window.open('https://example.com', '_blank')
      window.location.assign('https://example.com')
    })
    await page.waitForTimeout(500)
    expect(pageCount()).toBe(pagesBefore)
    expect(page.url()).not.toMatch(/^https:\/\/example\.com/)
    await page.close()
    await waitForCleanExit(child, processOutput)
  } finally {
    try {
      await browser?.close().catch(() => undefined)
      if (child?.exitCode === null) child.kill()
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true })
    }
  }
})
