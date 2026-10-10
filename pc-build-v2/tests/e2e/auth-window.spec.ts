import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

test.skip(
  process.platform !== 'win32',
  'Authentication desktop smoke runs on Windows only',
)

test('built Windows auth opens login first and asks for a key only during registration', async () => {
  test.setTimeout(90_000)
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'snipe-accounts-auth-'))
  // Production bundles resolve resources from Electron's runtime directory. This
  // test launcher supplies the project's public resources without packaging.
  const launcher = join(userDataDirectory, 'launch.mjs')
  await writeFile(
    launcher,
    `Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(join(process.cwd(), 'resources'))} });\nawait import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'out', 'main', 'bootstrap.js')).href)});\n`,
  )
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') environment[key] = value
  }
  let application: ElectronApplication | undefined
  try {
    application = await electron.launch({
      executablePath: join(
        process.cwd(),
        'node_modules',
        'electron',
        'dist',
        'electron.exe',
      ),
      args: [launcher, `--user-data-dir=${userDataDirectory}`],
      env: environment,
      timeout: 30_000,
    })
    const page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible()
    await expect(page.getByLabel('Ключ приглашения')).toHaveCount(0)
    await expect(page.getByText(/Уже есть аккаунт на телефоне или сайте/)).toBeVisible()
    const view = await page.evaluate(() => window.crToolsAuth.getView())
    expect(view).toEqual({ state: 'UNAUTHENTICATED', user: null, error: null })
    const keys = await page.evaluate(() => Object.keys(window.crToolsAuth))
    expect(keys).toContain('resetLogin')
    expect(keys).not.toContain('checkInvite')
    expect(keys).not.toContain('activateInvite')
    await page.getByRole('button', { name: 'Регистрация', exact: true }).click()
    await expect(page.getByLabel('Почта')).toBeVisible()
    await expect(page.getByLabel('Имя пользователя')).toBeVisible()
    await expect(page.getByLabel('Пароль')).toBeVisible()
    await expect(page.getByLabel('Ключ приглашения')).toBeVisible()
    await expect(page.getByText(/Ключ выдаёт администратор/)).toBeVisible()
    await page.getByLabel('Ключ приглашения').fill('short')
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click()
    await expect(page.getByText(/Ключ — от 8 до 50 символов/)).toBeVisible()
    await page.getByLabel('Ключ приглашения').fill(' test_key-123 ')
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click()
    await expect(page.getByText(/Ключ — от 8 до 50 символов/)).toHaveCount(0)
    await page.getByRole('button', { name: 'Вход', exact: true }).click()
    await expect(page.getByLabel('Ключ приглашения')).toHaveCount(0)
    await expect(page.getByLabel('Имя пользователя')).toHaveCount(0)
  } finally {
    await application?.close().catch(() => undefined)
    await rm(userDataDirectory, { recursive: true, force: true })
  }
})
