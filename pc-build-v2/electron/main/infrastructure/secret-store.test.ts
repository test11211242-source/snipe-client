import { describe, expect, it } from 'vitest'

import type { SecretFileSystem } from './secret-store'
import { SecretStore } from './secret-store'

function fakeFileSystem(): SecretFileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readFile: (path) => {
      const value = files.get(path)
      if (value === undefined)
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      return Promise.resolve(value)
    },
    writeFile: (path, data) => {
      files.set(path, data)
      return Promise.resolve()
    },
    rename: (from, to) => {
      const value = files.get(from)
      if (value === undefined) return Promise.reject(new Error('source missing'))
      files.set(to, value)
      files.delete(from)
      return Promise.resolve()
    },
    mkdir: () => Promise.resolve(),
    rm: (path) => {
      files.delete(path)
      return Promise.resolve()
    },
  }
}

describe('SecretStore', () => {
  it('persists only encrypted refresh data through an atomic rename', async () => {
    const fs = fakeFileSystem()
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`cipher:${value}`).reverse(),
      decryptString: (value: Buffer) => value.reverse().toString().replace('cipher:', ''),
    }
    const store = new SecretStore('/data/auth.enc', crypto, fs)
    await store.saveRefreshToken('refresh-secret')

    const persisted = fs.files.get('/data/auth.enc')
    expect(persisted).toBeDefined()
    if (persisted === undefined) throw new Error('persisted secret is missing')
    expect(persisted).not.toContain('refresh-secret')
    expect([...fs.files.keys()]).toEqual(['/data/auth.enc'])
    await expect(store.loadRefreshToken()).resolves.toBe('refresh-secret')
  })

  it('fails closed when encryption is unavailable and rejects corrupt ciphertext', async () => {
    const fs = fakeFileSystem()
    const unavailable = new SecretStore(
      '/data/auth.enc',
      {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      fs,
    )
    await expect(unavailable.saveRefreshToken('secret')).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    })
    expect(fs.files.size).toBe(0)

    fs.files.set('/data/auth.enc', '{"version":1,"ciphertext":"broken"}')
    const corrupt = new SecretStore(
      '/data/auth.enc',
      {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => {
          throw new Error('DPAPI rejected data')
        },
      },
      fs,
    )
    await expect(corrupt.loadRefreshToken()).rejects.toMatchObject({
      code: 'SECRET_INVALID',
    })
  })
})
