import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { promises as fileSystem } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SignedUpdateManifest,
  UpdateManifestPayload,
} from '../../../shared/contracts/update'
import { canonicalizeUpdatePayload } from '../../../shared/update-manifest.mjs'
import { nodeUpdateDependencies, UpdateService } from './update-service'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => fileSystem.rm(path, { recursive: true })),
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await fileSystem.mkdtemp(join(tmpdir(), 'cr-tools-update-test-'))
  temporaryDirectories.push(path)
  return path
}

function signedManifest(
  artifact: Uint8Array,
  overrides: Partial<UpdateManifestPayload['artifact']> = {},
): SignedUpdateManifest {
  const version = '1.1.0'
  const payload: UpdateManifestPayload = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    publishedAt: '2026-07-12T12:00:00.000Z',
    critical: false,
    notes: ['Update test'],
    artifact: {
      fileName: `CR_Tools_V2_Setup_${version}.exe`,
      size: artifact.byteLength,
      sha512: createHash('sha512').update(artifact).digest('base64'),
      url: `https://updates.artcsworld.xyz/downloads/v2/CR_Tools_V2_Setup_${version}.exe`,
      ...overrides,
    },
  }
  return {
    ...payload,
    signature: sign(
      null,
      Buffer.from(canonicalizeUpdatePayload(payload), 'utf8'),
      keys.privateKey,
    ).toString('base64'),
  }
}

function manifestResponse(manifest: SignedUpdateManifest): Response {
  return new Response(JSON.stringify(manifest), { status: 200 })
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

async function service(
  fetch: typeof globalThis.fetch,
  options: {
    launchVerifiedInstaller?: (installer: {
      path: string
      size: number
      sha512: string
    }) => Promise<void>
    requestShutdown?: () => Promise<void>
    isPackaged?: boolean
    platform?: NodeJS.Platform
  } = {},
): Promise<UpdateService> {
  const userData = await temporaryDirectory()
  return new UpdateService({
    fetch,
    ...nodeUpdateDependencies,
    launchVerifiedInstaller:
      options.launchVerifiedInstaller ?? vi.fn().mockResolvedValue(undefined),
    requestShutdown: options.requestShutdown ?? vi.fn().mockResolvedValue(undefined),
    currentVersion: () => '1.0.0',
    userDataPath: () => userData,
    isPackaged: () => options.isPackaged ?? true,
    platform: () => options.platform ?? 'win32',
    publicKey,
  })
}

function route(manifest: SignedUpdateManifest, artifact: Uint8Array): typeof fetch {
  return vi.fn((input: string | URL | Request) =>
    Promise.resolve(
      requestUrl(input).endsWith('manifest.json')
        ? manifestResponse(manifest)
        : new Response(Buffer.from(artifact), { status: 200 }),
    ),
  )
}

describe('UpdateService', () => {
  it('reports unsupported development and non-Windows environments honestly', async () => {
    const fetch = vi.fn()
    const updater = await service(fetch, { isPackaged: false, platform: 'linux' })
    await expect(updater.check()).resolves.toMatchObject({
      state: 'FAILED',
      error: { code: 'UPDATER_UNSUPPORTED', retryable: false },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('coalesces duplicate checks', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact)
    let resolveFetch!: (response: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    ) as typeof globalThis.fetch
    const updater = await service(fetch)
    const first = updater.check()
    const second = updater.check()
    expect(first).toBe(second)
    resolveFetch(manifestResponse(manifest))
    await expect(first).resolves.toMatchObject({ state: 'AVAILABLE' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects malicious redirect origin and path', async () => {
    for (const location of [
      'https://evil.example/downloads/v2/manifest.json',
      'https://updates.artcsworld.xyz/not-v2/manifest.json',
    ]) {
      const updater = await service(
        vi
          .fn()
          .mockResolvedValue(
            new Response(null, { status: 302, headers: { location } }),
          ) as typeof fetch,
      )
      await expect(updater.check()).resolves.toMatchObject({
        state: 'FAILED',
        error: { code: 'UPDATE_LOCATION_REJECTED' },
      })
    }
  })

  it('rejects declared and actual oversize responses', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact)
    const declaredFetch = vi.fn((input: string | URL | Request) =>
      Promise.resolve(
        requestUrl(input).endsWith('manifest.json')
          ? manifestResponse(manifest)
          : new Response(artifact, {
              status: 200,
              headers: { 'content-length': '4' },
            }),
      ),
    )
    const declaredUpdater = await service(declaredFetch)
    await declaredUpdater.check()
    await expect(declaredUpdater.download()).resolves.toMatchObject({
      state: 'FAILED',
      error: { code: 'ARTIFACT_SIZE_MISMATCH' },
    })

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('abcd'))
        controller.close()
      },
    })
    const actualFetch = vi.fn((input: string | URL | Request) =>
      Promise.resolve(
        requestUrl(input).endsWith('manifest.json')
          ? manifestResponse(manifest)
          : new Response(body, { status: 200 }),
      ),
    )
    const actualUpdater = await service(actualFetch)
    await actualUpdater.check()
    await expect(actualUpdater.download()).resolves.toMatchObject({
      state: 'FAILED',
      error: { code: 'ARTIFACT_TOO_LARGE' },
    })
  })

  it('cancels the response body when an exceptional download path rejects metadata', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact)
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch = vi.fn((input: string | URL | Request) =>
      Promise.resolve(
        requestUrl(input).endsWith('manifest.json')
          ? manifestResponse(manifest)
          : new Response(body, {
              status: 200,
              headers: { 'content-length': '4' },
            }),
      ),
    )
    const updater = await service(fetch)
    await updater.check()
    await updater.download()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('sweeps only stale updater-owned names at startup', async () => {
    const updater = await service(vi.fn() as typeof fetch)
    const userData = temporaryDirectories.at(-1)
    if (userData === undefined) throw new Error('Missing test directory')
    const directory = join(userData, 'updates')
    await fileSystem.mkdir(directory)
    const uuid = '29d970c1-fc4f-4bea-a767-8f108d3b8739'
    const stalePart = `CR_Tools_V2_Setup_1.1.0.exe.${uuid}.part`
    const staleFinal = `1.1.0-${uuid}.exe`
    const arbitrary = 'important-user-file.part'
    const freshOwned = `1.2.0-39d970c1-fc4f-4bea-a767-8f108d3b8739.exe`
    await Promise.all(
      [stalePart, staleFinal, arbitrary, freshOwned].map((name) =>
        fileSystem.writeFile(join(directory, name), name),
      ),
    )
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    await Promise.all(
      [stalePart, staleFinal, arbitrary].map((name) =>
        fileSystem.utimes(join(directory, name), old, old),
      ),
    )

    updater.start(60_000)
    await vi.waitFor(async () => {
      const names = await fileSystem.readdir(directory)
      expect(names).toEqual(expect.arrayContaining([arbitrary, freshOwned]))
      expect(names).not.toEqual(expect.arrayContaining([stalePart, staleFinal]))
    })
    await updater.stop()
  })

  it('rejects a hash mismatch and removes partial files', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact, {
      sha512: createHash('sha512').update('different').digest('base64'),
    })
    const updater = await service(route(manifest, artifact))
    await updater.check()
    await expect(updater.download()).resolves.toMatchObject({
      state: 'FAILED',
      error: { code: 'ARTIFACT_HASH_MISMATCH' },
    })
    const updateDirectories = await Promise.all(
      temporaryDirectories.map((path) =>
        fileSystem.readdir(join(path, 'updates')).catch(() => [] as string[]),
      ),
    )
    expect(updateDirectories.flat()).toEqual([])
  })

  it('cancels an owned download, cleans the partial, and ignores its stale failure', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact)
    let downloadStarted!: () => void
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve
    })
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(input).endsWith('manifest.json')) {
        return Promise.resolve(manifestResponse(manifest))
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('a'))
          downloadStarted()
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('cancelled', 'AbortError')),
          )
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const updater = await service(fetch)
    await updater.check()
    const downloading = updater.download()
    await started
    expect(updater.cancel()).toMatchObject({ state: 'AVAILABLE' })
    await downloading
    expect(updater.getView()).toMatchObject({ state: 'AVAILABLE', error: null })
    const files = await Promise.all(
      temporaryDirectories.map((path) =>
        fileSystem.readdir(join(path, 'updates')).catch(() => [] as string[]),
      ),
    )
    expect(files.flat()).toEqual([])
  })

  it('re-verifies immediately before install and does not launch a changed artifact', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact)
    const launch = vi
      .fn<(installer: { path: string; size: number; sha512: string }) => Promise<void>>()
      .mockResolvedValue(undefined)
    const updater = await service(route(manifest, artifact), {
      launchVerifiedInstaller: launch,
    })
    await updater.check()
    await expect(updater.download()).resolves.toMatchObject({ state: 'READY' })
    const userData = temporaryDirectories.at(-1)
    if (userData === undefined) throw new Error('Missing test directory')
    const files = await fileSystem.readdir(join(userData, 'updates'))
    const installer = files.find((file) => file.endsWith('.exe'))
    if (installer === undefined) throw new Error('Missing test installer')
    await fileSystem.writeFile(join(userData, 'updates', installer), 'changed')
    await expect(updater.install()).resolves.toMatchObject({
      state: 'FAILED',
      error: { code: 'ARTIFACT_SIZE_MISMATCH' },
    })
    expect(launch).not.toHaveBeenCalled()
  })

  it('keeps the app running when the verified installer fails to launch', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact)
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const updater = await service(route(manifest, artifact), {
      launchVerifiedInstaller: vi.fn().mockRejectedValue(new Error('launch failed')),
      requestShutdown: shutdown,
    })
    await updater.check()
    await updater.download()
    await expect(updater.install()).resolves.toMatchObject({
      state: 'FAILED',
      error: { code: 'INSTALLER_LAUNCH_FAILED' },
    })
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('passes exact trusted metadata to the locked launcher and shuts down only on success', async () => {
    const artifact = Buffer.from('abc')
    const manifest = signedManifest(artifact)
    const launch = vi
      .fn<(installer: { path: string; size: number; sha512: string }) => Promise<void>>()
      .mockResolvedValue(undefined)
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const updater = await service(route(manifest, artifact), {
      launchVerifiedInstaller: launch,
      requestShutdown: shutdown,
    })
    await updater.check()
    await updater.download()
    await expect(updater.install()).resolves.toMatchObject({ state: 'READY' })
    expect(launch).toHaveBeenCalledTimes(1)
    const installer = launch.mock.calls[0]?.[0]
    expect(installer?.path).toMatch(/\.exe$/)
    expect(installer?.size).toBe(artifact.byteLength)
    expect(installer?.sha512).toBe(manifest.artifact.sha512)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
