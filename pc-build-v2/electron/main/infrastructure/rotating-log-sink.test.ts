import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RotatingLogSink } from './rotating-log-sink'

const record = {
  timestamp: '2026-10-10T00:00:00Z',
  level: 'info' as const,
  message: 'safe metadata',
}
describe('RotatingLogSink', () => {
  it('serializes simultaneous records, rotates five bounded files and flushes shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-m0-log-'))
    try {
      const sink = new RotatingLogSink(directory, 250, 5)
      for (let index = 0; index < 30; index += 1) {
        sink.write({ ...record, context: { index } })
        await sink.flush()
      }
      const files = await readdir(directory)
      expect(files).toHaveLength(5)
      for (const file of files) {
        expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(250)
        for (const line of (await readFile(join(directory, file), 'utf8'))
          .trim()
          .split('\n')) {
          const parsed: unknown = JSON.parse(line)
          expect(parsed).toBeTypeOf('object')
        }
      }
      sink.write(record)
      sink.write(record)
      await sink.flush()
      expect((await readdir(directory)).length).toBe(5)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('tolerates unavailable disk and bounds oversized/pending writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cr-m0-log-'))
    try {
      const file = join(directory, 'not-directory')
      await writeFile(file, 'occupied')
      const sink = new RotatingLogSink(file, 250)
      sink.write(record)
      sink.write({ ...record, message: 'x'.repeat(1000) })
      await expect(sink.flush()).resolves.toBeUndefined()
      expect(await readFile(file, 'utf8')).toBe('occupied')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
