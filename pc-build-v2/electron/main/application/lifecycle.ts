import type { ApplicationLifecycleState } from '../../../shared/models/application'

const ALLOWED_TRANSITIONS: Readonly<
  Record<ApplicationLifecycleState, readonly ApplicationLifecycleState[]>
> = Object.freeze({
  BOOTING: ['AUTHENTICATING', 'SHUTTING_DOWN'],
  AUTHENTICATING: ['READY', 'RECOVERING', 'SHUTTING_DOWN'],
  READY: ['RECOVERING', 'SHUTTING_DOWN'],
  RECOVERING: ['READY', 'SHUTTING_DOWN'],
  SHUTTING_DOWN: ['STOPPED'],
  STOPPED: [],
})

export class ApplicationLifecycle {
  #state: ApplicationLifecycleState = 'BOOTING'

  get state(): ApplicationLifecycleState {
    return this.#state
  }

  canTransitionTo(next: ApplicationLifecycleState): boolean {
    return ALLOWED_TRANSITIONS[this.#state].includes(next)
  }

  transitionTo(next: ApplicationLifecycleState): void {
    if (!this.canTransitionTo(next)) {
      throw new Error(
        `Invalid application lifecycle transition: ${this.#state} -> ${next}`,
      )
    }

    this.#state = next
  }
}
