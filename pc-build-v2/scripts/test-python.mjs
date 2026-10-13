import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = join(
  root,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
)
if (!existsSync(python)) {
  console.log('Creating the isolated Python test environment (.venv).')
  const setup = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-m', 'venv', join(root, '.venv')],
    { cwd: root, stdio: 'inherit' },
  )
  if (setup.status !== 0) {
    console.error('Python 3.10+ is required to create the worktree test environment.')
    process.exit(setup.status ?? 1)
  }
}
const dependencies = spawnSync(python, ['-c', 'import pytest, cv2, numpy'], {
  cwd: root,
  stdio: 'ignore',
})
if (dependencies.status !== 0) {
  console.log('Installing pinned capture dependencies and pytest in .venv.')
  const install = spawnSync(
    python,
    ['-m', 'pip', 'install', '--no-cache-dir', '-r', 'python/requirements-dev.txt'],
    { cwd: root, stdio: 'inherit' },
  )
  if (install.status !== 0) process.exit(install.status ?? 1)
}
const result = spawnSync(python, ['-m', 'pytest', 'tests', '-m', 'not replay', ...process.argv.slice(2)], {
  cwd: join(root, 'python'),
  stdio: 'inherit',
})
if (result.error) console.error('The isolated Python test interpreter could not start.')
process.exit(result.status ?? 1)
