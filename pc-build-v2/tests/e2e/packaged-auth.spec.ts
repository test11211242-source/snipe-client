import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

test.skip(process.platform !== 'win32', 'Packaged Electron smoke runs on Windows only')

const executeFile = promisify(execFile)
const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'CR Tools V2.exe')
const resources = join(process.cwd(), 'release', 'win-unpacked', 'resources')

async function closeApplication(application: ElectronApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Packaged Electron did not exit cleanly within 15 seconds')),
          15_000,
        )
      }),
    ])
  } catch (error) {
    application.process().kill()
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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
  test.setTimeout(150_000)

  const userDataDirectory = await mkdtemp(join(tmpdir(), 'cr-tools-v2-e2e-'))
  let application: ElectronApplication | undefined
  try {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataDirectory}`],
      // The first Chromium endpoint follows cold Windows CIM and production auth bootstrap.
      timeout: 75_000,
    })
    const page = await application.firstWindow({ timeout: 45_000 })
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

    const pagesBefore = application.windows().length
    await page.evaluate(() => {
      window.open('https://example.com', '_blank')
      window.location.assign('https://example.com')
    })
    await page.waitForTimeout(500)
    expect(application.windows()).toHaveLength(pagesBefore)
    expect(page.url()).not.toMatch(/^https:\/\/example\.com/)
  } finally {
    try {
      if (application !== undefined) await closeApplication(application)
    } finally {
      await rm(userDataDirectory, { force: true, recursive: true })
    }
  }
})
