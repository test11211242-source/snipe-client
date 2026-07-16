import type { z } from 'zod'

import {
  InviteActivateRequestSchema,
  InviteCheckRequestSchema,
  LoginRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  ServerAuthResponseSchema,
  ServerInviteActivateResponseSchema,
  ServerInviteCheckResponseSchema,
  ServerMeResponseSchema,
  parseMeUser,
  toAuthUserView,
  type ServerTokens,
} from '../../../shared/contracts/server'
import { createApiError, type ApiError } from '../../../shared/errors/api-error'
import { ApplicationError } from '../../../shared/errors/application-error'
import { AuthViewSchema, type AuthView } from '../../../shared/models/auth'
import type { ApiClient, ApiResult } from './api-client'
import type { DeviceIdentityService } from './device-identity-service'

export interface RefreshTokenStore {
  loadRefreshToken: () => Promise<string | null>
  saveRefreshToken: (token: string) => Promise<void>
  invalidateAndClear: () => Promise<void>
}

export interface AuthSessionRevoker {
  revoke: (refreshToken: string) => Promise<void>
}

export type AuthViewListener = (view: AuthView) => void
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000

function errorFromUnknown(error: unknown): ApiError {
  if (error instanceof ApplicationError) {
    if (error.code === 'SECRET_UNAVAILABLE') {
      return createApiError('SECRET_UNAVAILABLE', error.message, false)
    }
    if (error.code === 'SECRET_INVALID') {
      return createApiError('SECRET_INVALID', error.message, false)
    }
    if (error.code === 'SECRET_CLEAR_FAILED') {
      return createApiError('SECRET_CLEAR_FAILED', error.message, true)
    }
    if (error.code.startsWith('DEVICE_')) {
      return createApiError('DEVICE_IDENTITY_UNAVAILABLE', error.message, false)
    }
  }
  return createApiError('UNKNOWN', 'Не удалось завершить операцию входа', true)
}

export class AuthSession {
  #view: AuthView = AuthViewSchema.parse({
    state: 'BOOTSTRAPPING',
    user: null,
    deviceHint: null,
    error: null,
  })
  #accessToken: string | null = null
  #refreshToken: string | null = null
  #inviteGranted = false
  #generation = 0
  #operationController = new AbortController()
  #refreshPromise: Promise<ApiResult<string>> | undefined
  #secretMutation: Promise<void> = Promise.resolve()
  readonly #listeners = new Set<AuthViewListener>()

  constructor(
    private readonly api: ApiClient,
    private readonly secrets: RefreshTokenStore,
    private readonly identity: DeviceIdentityService,
    private readonly revoker?: AuthSessionRevoker,
    private readonly bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  ) {}

  getView(): AuthView {
    return this.#view
  }

  subscribe(listener: AuthViewListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  cancelPendingOperations(): void {
    this.#operationController.abort()
    this.#operationController = new AbortController()
    this.#refreshPromise = undefined
    this.#generation += 1
  }

  async bootstrap(): Promise<AuthView> {
    const generation = this.beginOperation()
    this.#accessToken = null
    this.#refreshToken = null
    this.#refreshPromise = undefined
    this.update({ state: 'BOOTSTRAPPING', user: null, error: null })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<AuthView>((resolve) => {
      timer = setTimeout(() => {
        if (this.isCurrent(generation)) {
          this.cancelPendingOperations()
          this.fail(
            createApiError(
              'REQUEST_TIMEOUT',
              'Проверка защищённого сеанса заняла слишком много времени.',
              true,
            ),
          )
        }
        resolve(this.#view)
      }, this.bootstrapTimeoutMs)
    })

    try {
      return await Promise.race([this.runBootstrap(generation), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async runBootstrap(generation: number): Promise<AuthView> {
    const identity = await this.prepareIdentity(generation)
    if (identity === null) return this.#view
    const invite = await this.requestInviteCheck(identity.hwid, generation)
    if (!this.isCurrent(generation)) return this.#view
    if (!invite.ok) {
      this.fail(invite.error)
      return this.#view
    }
    this.#inviteGranted = invite.data.has_access
    if (!this.#inviteGranted) {
      this.update({ state: 'INVITE_REQUIRED', user: null, error: null })
      return this.#view
    }

    try {
      this.#refreshToken = await this.runSecretMutation(() =>
        this.secrets.loadRefreshToken(),
      )
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'SECRET_CLEAR_FAILED') {
        try {
          await this.runSecretMutation(() => this.secrets.invalidateAndClear())
          if (this.isCurrent(generation)) {
            this.update({ state: 'UNAUTHENTICATED', user: null, error: null })
          }
        } catch {
          if (this.isCurrent(generation)) this.fail(this.secretClearError())
        }
        return this.#view
      }
      await this.runSecretMutation(() => this.secrets.invalidateAndClear()).catch(
        () => undefined,
      )
      if (this.isCurrent(generation)) this.fail(errorFromUnknown(error))
      return this.#view
    }
    if (!this.isCurrent(generation)) return this.#view
    if (this.#refreshToken === null) {
      this.update({ state: 'UNAUTHENTICATED', user: null, error: null })
      return this.#view
    }

    const refreshed = await this.refreshAccessToken(generation)
    if (!this.isCurrent(generation)) return this.#view
    if (!refreshed.ok) {
      await this.handleAuthFailure(refreshed.error)
      return this.#view
    }
    await this.loadCurrentUser(generation, true)
    return this.#view
  }

  retryBootstrap(): Promise<AuthView> {
    return this.bootstrap()
  }

  async checkInvite(): Promise<AuthView> {
    const generation = this.beginOperation()
    this.update({ state: 'BOOTSTRAPPING', user: null, error: null })
    const identity = await this.prepareIdentity(generation)
    if (identity === null) return this.#view
    const result = await this.requestInviteCheck(identity.hwid, generation)
    if (!this.isCurrent(generation)) return this.#view
    if (!result.ok) this.fail(result.error)
    else if (result.data.has_access) {
      this.#inviteGranted = true
      this.update({ state: 'UNAUTHENTICATED', user: null, error: null })
    } else {
      this.update({ state: 'INVITE_REQUIRED', user: null, error: null })
    }
    return this.#view
  }

  async activateInvite(inviteCode: string): Promise<AuthView> {
    const generation = this.beginOperation()
    const identity = await this.prepareIdentity(generation)
    if (identity === null) return this.#view
    const body = InviteActivateRequestSchema.parse({
      invite_code: inviteCode,
      hwid: identity.hwid,
    })
    const result = await this.api.request({
      method: 'POST',
      path: '/api/invite-keys/validate',
      body,
      schema: ServerInviteActivateResponseSchema,
      signal: this.signalFor(generation),
    })
    if (!this.isCurrent(generation)) return this.#view
    if (!result.ok) this.fail(result.error)
    else if (!result.data.success) {
      this.update({
        state: 'INVITE_REQUIRED',
        user: null,
        error: createApiError(
          'VALIDATION_FAILED',
          result.data.message ?? 'Инвайт-код недействителен',
          false,
        ),
      })
    } else {
      this.#inviteGranted = true
      this.update({ state: 'UNAUTHENTICATED', user: null, error: null })
    }
    return this.#view
  }

  async login(email: string, password: string): Promise<AuthView> {
    const generation = this.beginOperation()
    this.update({ state: 'BOOTSTRAPPING', user: null, error: null })
    try {
      return await this.authenticate(
        '/api/auth/login',
        LoginRequestSchema.parse({
          email,
          password,
          hwid: await this.identity.getIdentity(),
        }),
        generation,
      )
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(errorFromUnknown(error))
      return this.#view
    }
  }

  async register(email: string, username: string, password: string): Promise<AuthView> {
    const generation = this.beginOperation()
    this.update({ state: 'BOOTSTRAPPING', user: null, error: null })
    try {
      const body = RegisterRequestSchema.parse({
        email,
        username,
        password,
        hwid: await this.identity.getIdentity(),
      })
      return await this.authenticate('/api/auth/register', body, generation)
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(errorFromUnknown(error))
      return this.#view
    }
  }

  async getAccessToken(forceRefresh = false): Promise<string | null> {
    if (!forceRefresh && this.#accessToken !== null) return this.#accessToken
    if (this.#refreshToken === null) return null
    const generation = this.#generation
    const result = await this.refreshAccessToken(generation)
    if (
      !result.ok &&
      this.isCurrent(generation) &&
      (result.error.code === 'UNAUTHORIZED' || result.error.code === 'FORBIDDEN')
    ) {
      await this.handleAuthFailure(result.error)
    }
    return result.ok && this.isCurrent(generation) ? result.data : null
  }

  async logout(): Promise<AuthView> {
    const tokenToRevoke = this.#refreshToken
    this.beginOperation()
    this.#accessToken = null
    this.#refreshToken = null
    this.#refreshPromise = undefined
    if (tokenToRevoke !== null && this.revoker !== undefined) {
      await this.revoker.revoke(tokenToRevoke).catch(() => undefined)
    }
    let clearFailed = false
    try {
      await this.runSecretMutation(() => this.secrets.invalidateAndClear())
    } catch {
      clearFailed = true
    }
    this.update({
      state: clearFailed
        ? 'ERROR'
        : this.#inviteGranted
          ? 'UNAUTHENTICATED'
          : 'INVITE_REQUIRED',
      user: null,
      error: clearFailed ? this.secretClearError() : null,
    })
    return this.#view
  }

  private async authenticate(
    path: '/api/auth/login' | '/api/auth/register',
    body: z.infer<typeof LoginRequestSchema> | z.infer<typeof RegisterRequestSchema>,
    generation: number,
  ): Promise<AuthView> {
    if (!this.#inviteGranted) {
      this.update({ state: 'INVITE_REQUIRED', user: null, error: null })
      return this.#view
    }
    if (!this.isCurrent(generation)) return this.#view
    const result = await this.api.request({
      method: 'POST',
      path,
      body,
      schema: ServerAuthResponseSchema,
      signal: this.signalFor(generation),
    })
    if (!this.isCurrent(generation)) return this.#view
    if (!result.ok) {
      if (result.error.code === 'FORBIDDEN') {
        await this.handleAuthFailure(result.error, false)
      } else {
        this.update({ state: 'UNAUTHENTICATED', user: null, error: result.error })
      }
      return this.#view
    }
    if (result.data.success === false) {
      this.fail(createApiError('VALIDATION_FAILED', 'Сервер отклонил запрос', false))
      return this.#view
    }

    const tokens = result.data.tokens
    if (tokens === undefined) {
      this.update({ state: 'UNAUTHENTICATED', user: null, error: null })
      return this.#view
    }
    const committed = await this.commitTokens(tokens, generation)
    if (!committed) return this.#view
    if (result.data.user !== undefined) {
      this.update({
        state: 'AUTHENTICATED',
        user: toAuthUserView(result.data.user),
        error: null,
      })
    } else {
      await this.loadCurrentUser(generation, true)
    }
    return this.#view
  }

  private async prepareIdentity(generation: number): Promise<{ hwid: string } | null> {
    try {
      const [hwid, hint] = await Promise.all([
        this.identity.getIdentity(),
        this.identity.getMaskedHint(),
      ])
      if (!this.isCurrent(generation)) return null
      this.update({ deviceHint: hint })
      return { hwid }
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(errorFromUnknown(error))
      return null
    }
  }

  private requestInviteCheck(hwid: string, generation: number) {
    return this.api.request({
      method: 'POST',
      path: '/api/invite-keys/check-hwid',
      body: InviteCheckRequestSchema.parse({ hwid }),
      schema: ServerInviteCheckResponseSchema,
      signal: this.signalFor(generation),
    })
  }

  private async refreshAccessToken(generation: number): Promise<ApiResult<string>> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise
    const refreshToken = this.#refreshToken
    if (refreshToken === null) {
      return {
        ok: false,
        error: createApiError('UNAUTHORIZED', 'Сеанс входа отсутствует', false),
      }
    }

    const operation = (async (): Promise<ApiResult<string>> => {
      const result = await this.api.request({
        method: 'POST',
        path: '/api/auth/refresh',
        body: RefreshRequestSchema.parse({ refresh_token: refreshToken }),
        schema: ServerAuthResponseSchema,
        signal: this.signalFor(generation),
      })
      if (!result.ok) return result
      const tokens = result.data.tokens
      if (tokens === undefined) {
        return {
          ok: false,
          error: createApiError(
            'INVALID_RESPONSE',
            'Сервер не вернул access token',
            true,
          ),
        }
      }
      if (!this.isCurrent(generation)) {
        return {
          ok: false,
          error: createApiError('AUTH_CANCELLED', 'Операция отменена', false),
        }
      }
      const committed = await this.commitTokens(tokens, generation)
      if (!committed) {
        return { ok: false, error: this.#view.error ?? errorFromUnknown(null) }
      }
      return { ok: true, status: result.status, data: tokens.access_token }
    })()
    this.#refreshPromise = operation
    void operation.finally(() => {
      if (this.#refreshPromise === operation) this.#refreshPromise = undefined
    })
    return operation
  }

  private async commitTokens(tokens: ServerTokens, generation: number): Promise<boolean> {
    const refreshToken = tokens.refresh_token ?? this.#refreshToken
    if (refreshToken === null) {
      this.fail(
        createApiError('INVALID_RESPONSE', 'Сервер не вернул refresh token', true),
      )
      return false
    }
    try {
      const saved = await this.runSecretMutation(async () => {
        if (!this.isCurrent(generation)) return false
        await this.secrets.saveRefreshToken(refreshToken)
        if (!this.isCurrent(generation)) {
          await this.secrets.invalidateAndClear().catch(() => undefined)
          return false
        }
        return true
      })
      if (!saved) return false
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(errorFromUnknown(error))
      return false
    }
    if (!this.isCurrent(generation)) return false
    this.#accessToken = tokens.access_token
    this.#refreshToken = refreshToken
    return true
  }

  private async loadCurrentUser(generation: number, retry401: boolean): Promise<void> {
    const token = this.#accessToken
    if (token === null) return
    const result = await this.api.request({
      method: 'GET',
      path: '/api/auth/me',
      accessToken: token,
      schema: ServerMeResponseSchema,
      signal: this.signalFor(generation),
    })
    if (!this.isCurrent(generation)) return
    if (!result.ok && result.error.code === 'UNAUTHORIZED' && retry401) {
      const refreshed = await this.refreshAccessToken(generation)
      if (refreshed.ok) return this.loadCurrentUser(generation, false)
      await this.handleAuthFailure(refreshed.error)
      return
    }
    if (!result.ok) {
      await this.handleAuthFailure(result.error)
      return
    }
    this.update({ state: 'AUTHENTICATED', user: parseMeUser(result.data), error: null })
  }

  private async handleAuthFailure(
    error: ApiError,
    clearUnauthorized = true,
  ): Promise<void> {
    if (error.code === 'FORBIDDEN') {
      this.#accessToken = null
      this.#refreshToken = null
      await this.runSecretMutation(() => this.secrets.invalidateAndClear()).catch(
        () => undefined,
      )
      this.update({ state: 'BLOCKED', user: null, error })
    } else if (error.code === 'UNAUTHORIZED' && clearUnauthorized) {
      this.#accessToken = null
      this.#refreshToken = null
      await this.runSecretMutation(() => this.secrets.invalidateAndClear()).catch(
        () => undefined,
      )
      this.update({ state: 'UNAUTHENTICATED', user: null, error })
    } else {
      this.fail(error)
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.#generation
  }

  private beginOperation(): number {
    this.#operationController.abort()
    this.#operationController = new AbortController()
    this.#refreshPromise = undefined
    return ++this.#generation
  }

  private signalFor(generation: number): AbortSignal {
    if (!this.isCurrent(generation)) {
      const controller = new AbortController()
      controller.abort()
      return controller.signal
    }
    return this.#operationController.signal
  }

  private runSecretMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#secretMutation.then(operation, operation)
    this.#secretMutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private fail(error: ApiError): void {
    this.update({
      state: error.code === 'FORBIDDEN' ? 'BLOCKED' : 'ERROR',
      user: null,
      error,
    })
  }

  private secretClearError(): ApiError {
    return createApiError(
      'SECRET_CLEAR_FAILED',
      'Не удалось удалить сохранённые данные входа. Повторите выход перед новым входом.',
      true,
    )
  }

  private update(patch: Partial<AuthView>): void {
    this.#view = AuthViewSchema.parse({ ...this.#view, ...patch })
    for (const listener of this.#listeners) listener(this.#view)
  }
}
