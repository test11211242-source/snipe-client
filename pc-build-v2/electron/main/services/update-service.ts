import { createHash, randomUUID, verify, type Hash } from 'node:crypto'
import { promises as nodeFileSystem } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import {
  UPDATE_ARTIFACT_MAX_BYTES,
  UPDATE_MANIFEST_MAX_BYTES,
  UPDATE_MANIFEST_URL,
  UPDATE_ORIGIN,
  UPDATE_PATH_PREFIX,
  type SignedUpdateManifest,
} from '../../../shared/contracts/update'
import {
  UpdateViewSchema,
  type UpdatePublicError,
  type UpdateView,
} from '../../../shared/models/update'
import { UpdateValidationError, verifyUpdateManifest } from './update-manifest-verifier'
import type { VerifiedInstallerLauncher } from './launch-verified-installer'

type UpdateFileSystem = Pick<
  typeof nodeFileSystem,
  'chmod' | 'mkdir' | 'open' | 'opendir' | 'rename' | 'rm' | 'stat'
>

interface UpdateCrypto {
  createHash: (algorithm: string) => Hash
  randomUUID: () => string
  verify: typeof verify
}

interface UpdateTimers {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

export interface UpdateServiceDependencies {
  fetch: typeof globalThis.fetch
  fileSystem: UpdateFileSystem
  crypto: UpdateCrypto
  launchVerifiedInstaller: VerifiedInstallerLauncher
  requestShutdown: () => Promise<void>
  currentVersion: () => string
  userDataPath: () => string
  isPackaged: () => boolean
  platform: () => NodeJS.Platform
  publicKey: string
  timers: UpdateTimers
}

interface ReadyArtifact {
  path: string
  size: number
  sha512: string
  generation: number
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const REQUEST_TIMEOUT_MS = 10_000
const DOWNLOAD_INACTIVITY_MS = 30_000
const STALE_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_STARTUP_SWEEP_ENTRIES = 256
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const OWNED_PART_PATTERN = new RegExp(
  `^CR_Tools_V2_Setup_(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.exe\\.${UUID_PATTERN}\\.part$`,
)
const OWNED_FINAL_PATTERN = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)-${UUID_PATTERN}\\.exe$`,
)

export const nodeUpdateDependencies = {
  fileSystem: nodeFileSystem,
  crypto: { createHash, randomUUID, verify },
  timers: { setTimeout, clearTimeout },
}

function publicError(error: unknown): UpdatePublicError {
  if (error instanceof UpdateValidationError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'UPDATE_CANCELLED',
      message: 'The update operation was cancelled',
      retryable: true,
    }
  }
  return {
    code: 'UPDATE_FAILED',
    message: 'The update operation failed. Please try again.',
    retryable: true,
  }
}

function validateRedirectUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UpdateValidationError(
      'UPDATE_LOCATION_REJECTED',
      'Update location was rejected',
    )
  }
  if (
    url.origin !== UPDATE_ORIGIN ||
    !url.pathname.startsWith(UPDATE_PATH_PREFIX) ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new UpdateValidationError(
      'UPDATE_LOCATION_REJECTED',
      'Update location was rejected',
    )
  }
  return url
}

export class UpdateService {
  #view: UpdateView
  #candidate: SignedUpdateManifest | undefined
  #ready: ReadyArtifact | undefined
  #generation = 0
  #operationAbort: AbortController | undefined
  #checkPromise: Promise<UpdateView> | undefined
  #downloadPromise: Promise<UpdateView> | undefined
  #installPromise: Promise<UpdateView> | undefined
  #startupTimer: ReturnType<typeof setTimeout> | undefined
  #stopped = false

  constructor(private readonly dependencies: UpdateServiceDependencies) {
    this.#view = {
      state: 'IDLE',
      currentVersion: dependencies.currentVersion(),
      availableVersion: null,
      critical: false,
      releaseNotes: [],
      progress: null,
      error: null,
    }
  }

  getView(): UpdateView {
    return UpdateViewSchema.parse(structuredClone(this.#view))
  }

  start(delayMs = 15_000): void {
    if (this.#stopped || this.#startupTimer !== undefined) return
    void this.sweepStaleOwnedFiles().catch(() => undefined)
    this.#startupTimer = this.dependencies.timers.setTimeout(() => {
      this.#startupTimer = undefined
      void this.check()
    }, delayMs)
  }

  check(): Promise<UpdateView> {
    if (this.#checkPromise !== undefined) return this.#checkPromise
    if (this.#view.state === 'DOWNLOADING' || this.#installPromise !== undefined) {
      return Promise.resolve(this.getView())
    }
    this.#checkPromise = this.performCheck().finally(() => {
      this.#checkPromise = undefined
    })
    return this.#checkPromise
  }

  download(): Promise<UpdateView> {
    if (this.#downloadPromise !== undefined) return this.#downloadPromise
    if (this.#installPromise !== undefined) return Promise.resolve(this.getView())
    this.#downloadPromise = this.performDownload().finally(() => {
      this.#downloadPromise = undefined
    })
    return this.#downloadPromise
  }

  cancel(): UpdateView {
    if (this.#view.state !== 'DOWNLOADING') return this.getView()
    this.#generation += 1
    this.#operationAbort?.abort()
    this.#operationAbort = undefined
    this.#ready = undefined
    this.setView({
      state: this.#candidate === undefined ? 'IDLE' : 'AVAILABLE',
      progress: null,
      error: null,
    })
    return this.getView()
  }

  install(): Promise<UpdateView> {
    if (this.#installPromise !== undefined) return this.#installPromise
    this.#installPromise = this.performInstall().finally(() => {
      this.#installPromise = undefined
    })
    return this.#installPromise
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#generation += 1
    if (this.#startupTimer !== undefined) {
      this.dependencies.timers.clearTimeout(this.#startupTimer)
      this.#startupTimer = undefined
    }
    this.#operationAbort?.abort()
    this.#operationAbort = undefined
    await this.#downloadPromise?.catch(() => undefined)
  }

  private supported(): boolean {
    return this.dependencies.isPackaged() && this.dependencies.platform() === 'win32'
  }

  private unsupportedView(): UpdateView {
    this.setView({
      state: 'FAILED',
      progress: null,
      error: {
        code: 'UPDATER_UNSUPPORTED',
        message: 'Updates are available only in the packaged Windows application',
        retryable: false,
      },
    })
    return this.getView()
  }

  private async performCheck(): Promise<UpdateView> {
    if (!this.supported()) return this.unsupportedView()
    const generation = ++this.#generation
    const previousReady = this.#ready
    this.#candidate = undefined
    this.#ready = undefined
    if (previousReady !== undefined) {
      await this.dependencies.fileSystem
        .rm(previousReady.path, { force: true })
        .catch(() => undefined)
    }
    this.setView({
      state: 'CHECKING',
      availableVersion: null,
      critical: false,
      releaseNotes: [],
      progress: null,
      error: null,
    })
    const abort = new AbortController()
    this.#operationAbort = abort
    try {
      const bytes = await this.fetchBytes(
        UPDATE_MANIFEST_URL,
        UPDATE_MANIFEST_MAX_BYTES,
        abort,
      )
      const result = verifyUpdateManifest(
        bytes,
        this.dependencies.publicKey,
        this.dependencies.currentVersion(),
        this.dependencies.crypto.verify,
      )
      if (generation !== this.#generation || this.#stopped) return this.getView()
      if (!result.updateAvailable) {
        this.setView({ state: 'UP_TO_DATE', error: null })
        return this.getView()
      }
      this.#candidate = result.manifest
      this.setView({
        state: 'AVAILABLE',
        availableVersion: result.manifest.version,
        critical: result.manifest.critical,
        releaseNotes: result.manifest.notes,
        error: null,
      })
    } catch (error) {
      if (generation === this.#generation && !this.#stopped) {
        this.setView({ state: 'FAILED', progress: null, error: publicError(error) })
      }
    } finally {
      if (this.#operationAbort === abort) this.#operationAbort = undefined
    }
    return this.getView()
  }

  private async performDownload(): Promise<UpdateView> {
    if (!this.supported()) return this.unsupportedView()
    if (this.#candidate === undefined) await this.check()
    const candidate = this.#candidate
    if (candidate === undefined || this.#view.state !== 'AVAILABLE') return this.getView()

    const generation = ++this.#generation
    const abort = new AbortController()
    this.#operationAbort = abort
    const directory = join(this.dependencies.userDataPath(), 'updates')
    const unique = this.dependencies.crypto.randomUUID()
    const partialPath = join(directory, `${candidate.artifact.fileName}.${unique}.part`)
    const finalPath = join(directory, `${candidate.version}-${unique}.exe`)
    this.setView({
      state: 'DOWNLOADING',
      progress: {
        downloadedBytes: 0,
        totalBytes: candidate.artifact.size,
        percent: 0,
      },
      error: null,
    })
    let handle: FileHandle | undefined
    let response: Response | undefined
    try {
      await this.dependencies.fileSystem.mkdir(directory, { recursive: true })
      handle = await this.dependencies.fileSystem.open(partialPath, 'wx', 0o600)
      response = await this.fetchFollowing(candidate.artifact.url, abort)
      const declaredLength = response.headers.get('content-length')
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) ||
          Number(declaredLength) !== candidate.artifact.size)
      ) {
        throw new UpdateValidationError(
          'ARTIFACT_SIZE_MISMATCH',
          'The update download size did not match its trusted metadata',
          true,
        )
      }
      if (response.body === null) {
        throw new UpdateValidationError(
          'DOWNLOAD_FAILED',
          'The update response was empty',
          true,
        )
      }
      const reader = response.body.getReader()
      const hash = this.dependencies.crypto.createHash('sha512')
      let bytesWritten = 0
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined
      let streamComplete = false
      const armInactivity = (): void => {
        if (inactivityTimer !== undefined)
          this.dependencies.timers.clearTimeout(inactivityTimer)
        inactivityTimer = this.dependencies.timers.setTimeout(
          () => abort.abort(),
          DOWNLOAD_INACTIVITY_MS,
        )
      }
      armInactivity()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            streamComplete = true
            break
          }
          armInactivity()
          bytesWritten += value.byteLength
          if (
            bytesWritten > candidate.artifact.size ||
            bytesWritten > UPDATE_ARTIFACT_MAX_BYTES
          ) {
            throw new UpdateValidationError(
              'ARTIFACT_TOO_LARGE',
              'The update download exceeded its trusted size',
            )
          }
          hash.update(value)
          await handle.write(value)
          if (generation === this.#generation) {
            this.setView({
              progress: {
                downloadedBytes: bytesWritten,
                totalBytes: candidate.artifact.size,
                percent: Math.min(100, (bytesWritten / candidate.artifact.size) * 100),
              },
            })
          }
        }
      } finally {
        if (inactivityTimer !== undefined)
          this.dependencies.timers.clearTimeout(inactivityTimer)
        if (!streamComplete) await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      if (bytesWritten !== candidate.artifact.size) {
        throw new UpdateValidationError(
          'ARTIFACT_SIZE_MISMATCH',
          'The update download was incomplete',
          true,
        )
      }
      if (hash.digest('base64') !== candidate.artifact.sha512) {
        throw new UpdateValidationError(
          'ARTIFACT_HASH_MISMATCH',
          'The update download failed integrity verification',
        )
      }
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.dependencies.fileSystem.chmod(partialPath, 0o600).catch(() => undefined)
      await this.dependencies.fileSystem.rename(partialPath, finalPath)
      const ready: ReadyArtifact = {
        path: finalPath,
        size: candidate.artifact.size,
        sha512: candidate.artifact.sha512,
        generation,
      }
      await this.verifyArtifact(ready)
      if (generation !== this.#generation || this.#stopped) {
        await this.dependencies.fileSystem.rm(finalPath, { force: true })
        return this.getView()
      }
      this.#ready = ready
      this.setView({ state: 'READY', progress: null, error: null })
    } catch (error) {
      await response?.body?.cancel().catch(() => undefined)
      await handle?.close().catch(() => undefined)
      await this.dependencies.fileSystem
        .rm(partialPath, { force: true })
        .catch(() => undefined)
      await this.dependencies.fileSystem
        .rm(finalPath, { force: true })
        .catch(() => undefined)
      if (generation === this.#generation && !this.#stopped) {
        this.setView({ state: 'FAILED', progress: null, error: publicError(error) })
      }
    } finally {
      if (this.#operationAbort === abort) this.#operationAbort = undefined
    }
    return this.getView()
  }

  private async performInstall(): Promise<UpdateView> {
    if (!this.supported()) return this.unsupportedView()
    await this.#checkPromise?.catch(() => undefined)
    await this.#downloadPromise?.catch(() => undefined)
    const ready = this.#ready
    if (ready?.generation !== this.#generation || this.#view.state !== 'READY') {
      this.setView({
        state: 'FAILED',
        error: {
          code: 'INSTALLER_NOT_READY',
          message: 'Download and verify the update before installing it',
          retryable: true,
        },
      })
      return this.getView()
    }
    try {
      await this.verifyArtifact(ready)
      try {
        await this.dependencies.launchVerifiedInstaller({
          path: ready.path,
          size: ready.size,
          sha512: ready.sha512,
        })
      } catch {
        throw new UpdateValidationError(
          'INSTALLER_LAUNCH_FAILED',
          'Windows could not launch the verified installer',
          true,
        )
      }
      await this.dependencies.requestShutdown()
    } catch (error) {
      this.setView({ state: 'FAILED', error: publicError(error) })
    }
    return this.getView()
  }

  private async verifyArtifact(artifact: ReadyArtifact): Promise<void> {
    const before = await this.dependencies.fileSystem.stat(artifact.path)
    if (!before.isFile() || before.size !== artifact.size) {
      throw new UpdateValidationError(
        'ARTIFACT_SIZE_MISMATCH',
        'The downloaded installer changed before installation',
      )
    }
    const handle = await this.dependencies.fileSystem.open(artifact.path, 'r')
    try {
      const hash = this.dependencies.crypto.createHash('sha512')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      let position = 0
      while (position < artifact.size) {
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, artifact.size - position),
          position,
        )
        if (read.bytesRead === 0) break
        hash.update(buffer.subarray(0, read.bytesRead))
        position += read.bytesRead
      }
      if (position !== artifact.size || hash.digest('base64') !== artifact.sha512) {
        throw new UpdateValidationError(
          'ARTIFACT_HASH_MISMATCH',
          'The downloaded installer changed before installation',
        )
      }
    } finally {
      await handle.close()
    }
    const after = await this.dependencies.fileSystem.stat(artifact.path)
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new UpdateValidationError(
        'ARTIFACT_CHANGED',
        'The downloaded installer changed before installation',
      )
    }
  }

  private async fetchBytes(
    url: string,
    maximumBytes: number,
    abort: AbortController,
  ): Promise<Uint8Array> {
    const response = await this.fetchFollowing(url, abort)
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new UpdateValidationError(
        'MANIFEST_TOO_LARGE',
        'Update metadata is too large',
      )
    }
    if (response.body === null) {
      throw new UpdateValidationError(
        'MANIFEST_INVALID',
        'Update metadata was empty',
        true,
      )
    }
    const reader = response.body.getReader()
    const timeout = this.dependencies.timers.setTimeout(
      () => abort.abort(),
      REQUEST_TIMEOUT_MS,
    )
    const chunks: Uint8Array[] = []
    let total = 0
    let streamComplete = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          streamComplete = true
          break
        }
        total += value.byteLength
        if (total > maximumBytes) {
          await reader.cancel()
          throw new UpdateValidationError(
            'MANIFEST_TOO_LARGE',
            'Update metadata is too large',
          )
        }
        chunks.push(value)
      }
    } finally {
      this.dependencies.timers.clearTimeout(timeout)
      if (!streamComplete) await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }

  private async fetchFollowing(
    urlValue: string,
    owner: AbortController,
  ): Promise<Response> {
    let url = validateRedirectUrl(urlValue)
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const timeout = this.dependencies.timers.setTimeout(
        () => owner.abort(),
        REQUEST_TIMEOUT_MS,
      )
      let response: Response
      try {
        response = await this.dependencies.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: owner.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/json, application/octet-stream' },
        })
      } finally {
        this.dependencies.timers.clearTimeout(timeout)
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined)
          throw new UpdateValidationError(
            'UPDATE_HTTP_FAILED',
            'The update server returned an unexpected response',
            response.status >= 500,
          )
        }
        return response
      }
      const location = response.headers.get('location')
      if (location === null || redirects === 2) {
        await response.body?.cancel().catch(() => undefined)
        throw new UpdateValidationError(
          'UPDATE_REDIRECT_REJECTED',
          'The update redirect was rejected',
        )
      }
      await response.body?.cancel().catch(() => undefined)
      url = validateRedirectUrl(new URL(location, url).href)
    }
    throw new UpdateValidationError(
      'UPDATE_REDIRECT_REJECTED',
      'Too many update redirects',
    )
  }

  private async sweepStaleOwnedFiles(): Promise<void> {
    const directory = join(this.dependencies.userDataPath(), 'updates')
    let handle: Awaited<ReturnType<UpdateFileSystem['opendir']>>
    try {
      handle = await this.dependencies.fileSystem.opendir(directory)
    } catch {
      return
    }
    const staleBefore = Date.now() - STALE_ARTIFACT_AGE_MS
    let inspected = 0
    try {
      for await (const entry of handle) {
        inspected += 1
        if (inspected > MAX_STARTUP_SWEEP_ENTRIES) break
        if (
          !OWNED_PART_PATTERN.test(entry.name) &&
          !OWNED_FINAL_PATTERN.test(entry.name)
        ) {
          continue
        }
        const path = join(directory, entry.name)
        const status = await this.dependencies.fileSystem.stat(path).catch(() => null)
        if (status !== null && status.mtimeMs <= staleBefore) {
          await this.dependencies.fileSystem
            .rm(path, { force: true })
            .catch(() => undefined)
        }
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  private setView(patch: Partial<UpdateView>): void {
    this.#view = UpdateViewSchema.parse({ ...this.#view, ...patch })
  }
}
