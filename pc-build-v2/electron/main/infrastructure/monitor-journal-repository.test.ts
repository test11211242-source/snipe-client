import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MonitorResultSchema } from '../../../shared/models/monitor'
import {
  canonicalOpponentTag,
  ENCOUNTER_LIMIT,
  HISTORY_LIMIT,
  localCalendarDay,
  MonitorJournalRepository,
  pruneJournal,
  SESSION_LIMIT,
  type MonitorJournal,
} from './monitor-journal-repository'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

function result(at = new Date(), tag: string | null = '#abc') {
  return MonitorResultSchema.parse({
    id: randomUUID(),
    timestamp: at.toISOString(),
    kind: 'player_found',
    searchMode: 'fast',
    deckMode: 'pol',
    searchedNickname: null,
    player: { name: 'Synthetic', tag, rating: null, clan: null },
    decks: [],
  })
}

function journal(): MonitorJournal {
  return {
    schemaVersion: 1,
    userId: 'synthetic-user',
    results: [],
    encounters: [],
    sessions: [],
  }
}

describe('bounded monitor journal', () => {
  it('persists safe results across repository instances and isolates users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'snipe-m1-journal-'))
    directories.push(directory)
    const repository = new MonitorJournalRepository(directory)
    const value = journal()
    value.results.push(result())
    await repository.save(value)
    await expect(
      new MonitorJournalRepository(directory).load(value.userId),
    ).resolves.toEqual(value)
    await expect(repository.load('other-user')).resolves.toMatchObject({
      results: [],
      encounters: [],
      sessions: [],
    })
  })

  it('serializes snapshots rather than persisting later caller mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'snipe-m1-journal-'))
    directories.push(directory)
    const repository = new MonitorJournalRepository(directory)
    const value = journal()
    const first = result()
    value.results.push(first)
    const saving = repository.save(value)
    value.results.length = 0
    await saving
    await expect(repository.load(value.userId)).resolves.toMatchObject({
      results: [first],
    })
  })

  it('prunes retention and enforces limits independently of the 20-row renderer cap', () => {
    const now = new Date(2026, 6, 12, 12)
    const value = journal()
    value.results = Array.from({ length: HISTORY_LIMIT + 25 }, () => result(now))
    value.results.push(result(new Date(2026, 5, 1)))
    value.encounters = Array.from({ length: ENCOUNTER_LIMIT + 5 }, () => ({
      tag: '#ABC',
      day: localCalendarDay(now),
      at: now.toISOString(),
      resultId: randomUUID(),
    }))
    value.sessions = Array.from({ length: SESSION_LIMIT + 5 }, () => ({
      initialProfileId: null,
      sessionId: randomUUID(),
      userId: value.userId,
      startedAt: now.toISOString(),
      endedAt: now.toISOString(),
      stopReason: 'user',
      durationMs: 0,
      stats: {
        triggers: 0,
        requests: 0,
        droppedActions: 0,
        playersFound: 0,
        playersNotFound: 0,
        recognitionFailures: 0,
        serviceErrors: 0,
      },
      repeatEncounters: 0,
      distinctRepeatedOpponents: 0,
    }))
    pruneJournal(value, now)
    expect(value.results).toHaveLength(HISTORY_LIMIT)
    expect(value.encounters).toHaveLength(ENCOUNTER_LIMIT)
    expect(value.sessions).toHaveLength(SESSION_LIMIT)
    expect(
      value.results.every((entry) => Date.parse(entry.timestamp) === now.getTime()),
    ).toBe(true)
  })

  it('uses OS-local calendar dates and canonical tags rather than names', () => {
    expect(localCalendarDay(new Date(2026, 6, 12, 23, 59))).toBe('2026-07-12')
    expect(localCalendarDay(new Date(2026, 6, 13, 0, 1))).toBe('2026-07-13')
    expect(canonicalOpponentTag(result(undefined, ' abc '))).toBe('#ABC')
    expect(canonicalOpponentTag(result(undefined, '#ABC'))).toBe('#ABC')
    expect(canonicalOpponentTag(result(undefined, null))).toBeNull()
  })

  it('rejects screenshots and private unrecognized fields before touching disk', () => {
    const repository = new MonitorJournalRepository('unused-synthetic-path')
    const value = journal()
    value.results.push({
      ...result(),
      imageBase64: 'private-crop',
    } as unknown as MonitorJournal['results'][number])
    expect(() => repository.save(value)).toThrow()
  })
})
