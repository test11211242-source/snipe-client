import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { transformWithEsbuild } from 'vite'
import {
  createVerifiedInstallerLauncher,
  VerifiedInstallerLaunchError,
} from './launch-verified-installer'

describe.skipIf(process.platform !== 'win32')(
  'Windows installer after Electron exit',
  () => {
    let directory: string
    let helper: string
    let probe: string
    let fixture: string

    beforeAll(async () => {
      if (!existsSync(join(process.cwd(), 'node_modules/electron/dist/electron.exe'))) {
        execFileSync(
          process.execPath,
          [join(process.cwd(), 'node_modules/electron/install.js')],
          { windowsHide: true, timeout: 120_000, stdio: 'pipe' },
        )
      }
      directory = await fs.mkdtemp(join(tmpdir(), 'cr-tools-handoff-'))
      helper = join(directory, 'installer-helper.exe')
      probe = join(directory, 'probe.exe')
      const builder = (await import(
        pathToFileURL(join(process.cwd(), 'scripts/build-installer-helper.mjs')).href
      )) as { buildInstallerHelper(output: string): void }
      builder.buildInstallerHelper(helper)
      const source = join(directory, 'Probe.cs')
      await fs.writeFile(
        source,
        String.raw`using System; using System.IO; public static class Probe { public static int Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable("CR_TOOLS_PROBE_OUTPUT"), String.Join(" ", args)); return Int32.Parse(Environment.GetEnvironmentVariable("CR_TOOLS_PROBE_EXIT_CODE")); } }`,
      )
      execFileSync(
        join(
          process.env['SystemRoot'] ?? 'C:\\Windows',
          'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
        ),
        ['/nologo', '/target:winexe', `/out:${probe}`, source],
        { windowsHide: true },
      )
      const launcherPath = join(import.meta.dirname, 'launch-verified-installer.ts')
      const compiled = await transformWithEsbuild(
        await fs.readFile(launcherPath, 'utf8'),
        launcherPath,
        { loader: 'ts', format: 'cjs' },
      )
      await fs.writeFile(join(directory, 'launcher.cjs'), compiled.code)
      fixture = join(directory, 'main.cjs')
      await fs.writeFile(
        fixture,
        String.raw`
const {app}=require('electron'); const fs=require('node:fs'); const cp=require('node:child_process'); const crypto=require('node:crypto');
const {createVerifiedInstallerLauncher}=require('./launcher.cjs');
app.whenReady().then(async()=>{
  const launcher=createVerifiedInstallerLauncher({platform:()=>process.platform,helperPath:()=>process.env.CR_TOOLS_PROBE_HELPER,parentProcessId:()=>process.pid,environment:()=>process.env,spawn:(exe,args,options)=>cp.spawn(exe,args,options),timers:{setTimeout,clearTimeout}});
  const bytes=fs.readFileSync(process.env.CR_TOOLS_PROBE_INSTALLER);
  const control=await launcher({path:process.env.CR_TOOLS_PROBE_INSTALLER,size:bytes.length,sha512:crypto.createHash('sha512').update(bytes).digest('base64')});
  await new Promise(resolve=>setTimeout(resolve,250));
  if(fs.existsSync(process.env.CR_TOOLS_PROBE_OUTPUT)) throw Error('Installer launched before application exit');
  if(process.env.CR_TOOLS_PROBE_CANCEL==='true') control.cancel();
  app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`,
      )
    }, 130_000)

    afterAll(async () => {
      if (directory)
        await fs.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
    })

    async function runParent(cancel: boolean, exitCode = 0): Promise<string> {
      const outputPath = join(
        directory,
        cancel ? 'cancelled.txt' : `installed-${exitCode}.txt`,
      )
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        CR_TOOLS_PROBE_HELPER: helper,
        CR_TOOLS_PROBE_INSTALLER: probe,
        CR_TOOLS_PROBE_OUTPUT: outputPath,
        CR_TOOLS_PROBE_CANCEL: String(cancel),
        CR_TOOLS_PROBE_EXIT_CODE: String(exitCode),
      }
      delete environment['ELECTRON_RUN_AS_NODE']
      const parent = spawn(
        join(process.cwd(), 'node_modules/electron/dist/electron.exe'),
        [fixture],
        { env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let errors = ''
      parent.stderr.on('data', (chunk: Buffer) => {
        errors = (errors + chunk.toString()).slice(-16_384)
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          parent.kill()
          reject(new Error('Electron parent did not exit'))
        }, 15_000)
        parent.once('error', reject)
        parent.once('exit', (exitCode) => {
          clearTimeout(timeout)
          resolve(exitCode)
        })
      })
      expect(code, errors).toBe(0)
      return outputPath
    }

    it('starts the verified installer only after a real Electron parent exits', async () => {
      const output = await runParent(false)
      await expect.poll(() => existsSync(output), { timeout: 10_000 }).toBe(true)
      expect(await fs.readFile(output, 'utf8')).toBe('/S --updated --force-run')
      await expect
        .poll(
          async () =>
            (await fs.readFile(probe + '.install.log', 'utf8')).includes(
              'Installation finished successfully',
            ),
          { timeout: 5_000 },
        )
        .toBe(true)
    }, 20_000)

    it('cancellation prevents installation even after the parent exits', async () => {
      const output = await runParent(true)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(existsSync(output)).toBe(false)
    }, 20_000)

    it('records an installer failure after the parent and its pipes are gone', async () => {
      await runParent(false, 23)
      await expect
        .poll(
          async () =>
            (await fs.readFile(probe + '.install.log', 'utf8')).includes(
              'FAILED: Installer exited with code 23',
            ),
          { timeout: 10_000 },
        )
        .toBe(true)
    }, 20_000)

    it('rejects a changed installer before acknowledging readiness', async () => {
      const bytes = await fs.readFile(probe)
      const launch = createVerifiedInstallerLauncher({
        platform: () => process.platform,
        helperPath: () => helper,
        parentProcessId: () => process.pid,
        environment: () => process.env,
        spawn: (exe, args, options) => spawn(exe, [...args], options),
        timers: { setTimeout, clearTimeout },
      })
      const failure: unknown = await launch({
        path: probe,
        size: bytes.length,
        sha512: createHash('sha512').update('tampered').digest('base64'),
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(VerifiedInstallerLaunchError)
      if (!(failure instanceof VerifiedInstallerLaunchError))
        throw new Error('Expected native helper failure')
      expect(failure.code).toBe('INSTALLER_HELPER_EXITED')
      expect(failure.diagnostic).toContain('Installer hash mismatch')
    })
  },
)
