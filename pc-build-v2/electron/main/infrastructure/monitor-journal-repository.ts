import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MonitorResultSchema,
  MonitorSessionSchema,
  type MonitorResult,
} from '../../../shared/models/monitor'

export const HISTORY_LIMIT = 2_000
export const ENCOUNTER_LIMIT = 40_000
export const SESSION_LIMIT = 100
export const RETENTION_DAYS = 7

export function localCalendarDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const EncounterSchema = z
  .object({
    tag: z.string().min(1).max(160),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    at: z.iso.datetime(),
    resultId: z.uuid(),
  })
  .strict()
const JournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    userId: z.string().min(1).max(128),
    results: z.array(MonitorResultSchema).max(HISTORY_LIMIT),
    encounters: z.array(EncounterSchema).max(ENCOUNTER_LIMIT),
    sessions: z.array(MonitorSessionSchema).max(SESSION_LIMIT),
  })
  .strict()
export type MonitorJournal = z.infer<typeof JournalSchema>

export class MonitorJournalRepository {
  #operation: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}

  async load(userId: string): Promise<MonitorJournal> {
    try {
      const parsed = JournalSchema.parse(
        JSON.parse(await fs.readFile(this.path(userId), 'utf8')),
      )
      if (parsed.userId !== userId) throw new Error('Journal user mismatch')
      return parsed
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { schemaVersion: 1, userId, results: [], encounters: [], sessions: [] }
      }
      throw error
    }
  }

  save(value: MonitorJournal): Promise<void> {
    const snapshot = JournalSchema.parse(value)
    const operation = this.#operation.then(async () => {
      await fs.mkdir(this.directory, { recursive: true })
      const destination = this.path(snapshot.userId)
      const temporary = `${destination}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8')
        await fs.rename(temporary, destination)
      } catch (error) {
        await fs.rm(temporary, { force: true })
        throw error
      }
    })
    this.#operation = operation.catch(() => undefined)
    return operation
  }

  private path(userId: string): string {
    return join(
      this.directory,
      `${createHash('sha256').update(userId).digest('hex')}.json`,
    )
  }
}

export function pruneJournal(journal: MonitorJournal, now: Date): void {
  const oldest = new Date(now)
  oldest.setDate(oldest.getDate() - RETENTION_DAYS)
  const cutoff = oldest.getTime()
  journal.results = journal.results
    .filter((result) => Date.parse(result.timestamp) >= cutoff)
    .slice(0, HISTORY_LIMIT)
  journal.encounters = journal.encounters
    .filter((entry) => Date.parse(entry.at) >= cutoff)
    .slice(-ENCOUNTER_LIMIT)
  journal.sessions = journal.sessions
    .filter((entry) => Date.parse(entry.startedAt) >= cutoff)
    .slice(-SESSION_LIMIT)
}

export function canonicalOpponentTag(result: MonitorResult): string | null {
  if (result.kind !== 'player_found' || result.player.tag === null) return null
  const tag = result.player.tag.trim().toUpperCase()
  return tag.length === 0 ? null : `#${tag.replace(/^#/, '')}`
}
