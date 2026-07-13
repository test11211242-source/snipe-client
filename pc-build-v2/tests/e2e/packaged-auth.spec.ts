import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

test.skip(process.platform !== 'win32', 'Packaged Electron smoke runs on Windows only')

const executeFile = promisify(execFile)
const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'CR Tools V2.exe')
const resources = join(process.cwd(), 'release', 'win-unpacked', 'resources')

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

const waitForWindowScript = String.raw`
$ErrorActionPreference = 'Stop'
$processId = [int]$env:CR_TOOLS_E2E_PID
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $process = Get-Process -Id $processId -ErrorAction Stop
  $process.Refresh()
  if ($process.MainWindowHandle -ne 0) {
    @{ handle = [int64]$process.MainWindowHandle; title = [string]$process.MainWindowTitle } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Packaged Electron did not create a native window within 30 seconds.'
`

const closeWindowScript = String.raw`
$ErrorActionPreference = 'Stop'
$processId = [int]$env:CR_TOOLS_E2E_PID
$process = Get-Process -Id $processId -ErrorAction Stop
if (-not $process.CloseMainWindow()) {
  throw 'CloseMainWindow rejected the shutdown request.'
}
`

test('packaged portable runtime contains the pinned capture stack', async () => {
  test.setTimeout(45_000)

  const python = join(resources, 'python-runtime', 'python.exe')
  await Promise.all([
    access(python),
    access(join(resources, 'python', 'capture_once.py')),
    access(join(resources, 'python', 'monitor_engine.py')),
    access(join(resources, 'runtime-integrity.json')),
    access(join(resources, 'update-public-key.pem')),
  ])
  const inventory = JSON.parse(
    await readFile(join(resources, 'runtime-integrity.json'), 'utf8'),
  ) as { root?: unknown; files?: unknown[] }
  expect(inventory.root).toBe('python-runtime')
  expect(inventory.files?.length).toBeGreaterThan(0)
  const publicKey = createPublicKey(
    await readFile(join(resources, 'update-public-key.pem'), 'utf8'),
  )
  const publicKeyFingerprint = createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex')
  expect(publicKeyFingerprint).toBe(
    '2a16488a2a16440e6c1ac19f82f9b262b7e9154d0851e3dbbac0be8d9b612d99',
  )
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
  let child: ChildProcess | undefined
  try {
    const environment = { ...process.env }
    delete environment['ELECTRON_RUN_AS_NODE']
    child = spawn(
      executablePath,
      [`--user-data-dir=${userDataDirectory}`, '--enable-logging=stderr'],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const processOutput = captureProcessOutput(child)
    if (child.pid === undefined) throw new Error('Packaged Electron process has no PID')
    const powershellEnvironment = {
      ...process.env,
      CR_TOOLS_E2E_PID: String(child.pid),
    }
    const windowResult = await executeFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', waitForWindowScript],
      { env: powershellEnvironment, timeout: 35_000, windowsHide: true },
    ).catch((error: unknown) => {
      throw new Error(`Native window check failed:\n${processOutput()}`, { cause: error })
    })
    const window = JSON.parse(windowResult.stdout) as {
      handle?: unknown
      title?: unknown
    }
    expect(window.handle).toEqual(expect.any(Number))
    expect(window.handle).not.toBe(0)
    expect(window.title).toEqual(expect.stringMatching(/CR Tools V2/))

    await executeFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', closeWindowScript],
      { env: powershellEnvironment, timeout: 10_000, windowsHide: true },
    )
    await waitForCleanExit(child, processOutput)
  } finally {
    try {
      if (child?.exitCode === null) child.kill()
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true })
    }
  }
})

test('packaged auth preload exposes a working IPC bridge', async () => {
  test.setTimeout(90_000)

  const userDataDirectory = await mkdtemp(join(tmpdir(), 'cr-tools-v2-bridge-e2e-'))
  let electronApp: ElectronApplication | undefined
  try {
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) environment[key] = value
    }
    delete environment['ELECTRON_RUN_AS_NODE']
    electronApp = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
      env: environment,
      timeout: 30_000,
    })
    const page = await electronApp.firstWindow()

    await expect
      .poll(() =>
        page.evaluate(() => ({
          bridge: typeof (window as unknown as { crToolsAuth?: unknown }).crToolsAuth,
          getView: typeof (window as unknown as { crToolsAuth?: { getView?: unknown } })
            .crToolsAuth?.getView,
        })),
      )
      .toEqual({ bridge: 'object', getView: 'function' })

    const view = await page.evaluate(() => window.crToolsAuth.getView())
    expect(view.state).toMatch(
      /^(BOOTSTRAPPING|INVITE_REQUIRED|UNAUTHENTICATED|AUTHENTICATED|BLOCKED|ERROR)$/,
    )
  } finally {
    await electronApp?.close().catch(() => undefined)
    await rm(userDataDirectory, { force: true, recursive: true })
  }
})
