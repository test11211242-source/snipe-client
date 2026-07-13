import { describe, expect, it, vi } from 'vitest'

import type { CaptureConfiguration } from '../../../shared/models/capture'
import {
  CaptureConfigurationRepository,
  captureConfigurationFingerprint,
  type CaptureConfigurationFileSystem,
} from './capture-configuration-repository'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test value')
  return value
}

function configuration(userId: string, revision = 1): CaptureConfiguration {
  const unsigned: Omit<CaptureConfiguration, 'fingerprint'> = {
    schemaVersion: 1,
    userId,
    revision,
    committedAt: '2026-07-12T12:00:00.000Z',
    source: { kind: 'window', label: 'Game', titleHint: 'Game', executableLabel: null },
    frameSize: { width: 1920, height: 1080 },
    regions: {
      trigger: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      normal: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
      precise: { x: 0.05, y: 0.1, width: 0.9, height: 0.8 },
    },
    triggerProfile: {
      schemaVersion: 2,
      analyzer: { name: 'cr-tools-trigger-analyzer', version: '1.0.0' },
      hashAlgorithm: 'ahash64-bitwise-v1',
      ahash64: '0123456789abcdef',
      innerRect: { x: 0, y: 0, width: 1, height: 1 },
      featureMode: 'ncc',
      keypointsCount: 0,
      normalizedTemplateSize: { width: 128, height: 128 },
      templateGrayBase64: 'AAAA',
      hashMaxDistance: 18,
      orbDistanceThreshold: 55,
      orbMinGoodMatches: 10,
      nccMinScore: 0.72,
    },
  }
  return { ...unsigned, fingerprint: captureConfigurationFingerprint(unsigned) }
}

describe('CaptureConfigurationRepository', () => {
  it('uses separate opaque per-user files and validates fingerprints', async () => {
    const files = new Map<string, string>()
    const fs: CaptureConfigurationFileSystem = {
      readFile: (path) => {
        const content = files.get(path)
        return content === undefined
          ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
          : Promise.resolve(content)
      },
      writeFile: (path, data) => {
        files.set(path, data)
        return Promise.resolve()
      },
      rename: (oldPath, newPath) => {
        files.set(newPath, required(files.get(oldPath)))
        files.delete(oldPath)
        return Promise.resolve()
      },
      mkdir: () => Promise.resolve(),
      rm: (path) => {
        files.delete(path)
        return Promise.resolve()
      },
    }
    const repository = new CaptureConfigurationRepository('/config', fs)
    await repository.save(configuration('user-a'))
    await repository.save(configuration('user-b'))
    expect([...files.keys()]).toHaveLength(2)
    expect([...files.keys()].join()).not.toContain('user-a')
    await expect(repository.load('user-a')).resolves.toMatchObject({ userId: 'user-a' })

    const userAPath = required(
      [...files.keys()].find((path) => files.get(path)?.includes('user-a')),
    )
    files.set(userAPath, required(files.get(userAPath)).replace('Game', 'Tampered'))
    await expect(repository.load('user-a')).resolves.toBeNull()
  })

  it('removes a temporary file when atomic rename fails', async () => {
    const rm = vi.fn().mockResolvedValue(undefined)
    const fs: CaptureConfigurationFileSystem = {
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockRejectedValue(new Error('disk full')),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rm,
    }
    const repository = new CaptureConfigurationRepository('/config', fs)
    await expect(repository.save(configuration('42'))).rejects.toThrow('disk full')
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('.tmp'), { force: true })
  })
})
