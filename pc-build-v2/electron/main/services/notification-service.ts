import type { MonitorResult } from '../../../shared/models/monitor'
import type { MonitorSupervisor } from './monitor-supervisor'

interface NativeNotification {
  show: () => void
}

export class NotificationService {
  #dispose: (() => void) | null = null
  readonly #seen = new Set<string>()
  readonly #order: string[] = []

  constructor(
    private readonly monitor: Pick<MonitorSupervisor, 'subscribeResults'>,
    private readonly supported: () => boolean,
    private readonly create: (options: {
      title: string
      body: string
    }) => NativeNotification,
    private readonly enabled: () => boolean = () => true,
  ) {}

  start(): void {
    if (this.#dispose !== null) return
    this.#dispose = this.monitor.subscribeResults((result) => this.accept(result))
  }

  stop(): void {
    this.#dispose?.()
    this.#dispose = null
    this.#seen.clear()
    this.#order.length = 0
  }

  private accept(result: MonitorResult): void {
    if (
      result.kind !== 'player_found' ||
      this.#seen.has(result.id) ||
      !this.enabled() ||
      !this.supported()
    ) {
      return
    }
    this.#seen.add(result.id)
    this.#order.push(result.id)
    while (this.#order.length > 100) {
      const oldest = this.#order.shift()
      if (oldest !== undefined) this.#seen.delete(oldest)
    }
    const name = result.player.name
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 80)
    const clan = result.player.clan
      ?.replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 80)
    this.create({
      title: 'CR Tools V2: player found',
      body: `${name}${clan ? ` - ${clan}` : ''}`.slice(0, 160),
    }).show()
  }
}
