import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const EXPECTED_PUBLIC_KEY_FINGERPRINT =
  '2a16488a2a16440e6c1ac19f82f9b262b7e9154d0851e3dbbac0be8d9b612d99'
const publicKeyPath = resolve(import.meta.dirname, '../resources/update-public-key.pem')

const publicKey = createPublicKey(await readFile(publicKeyPath, 'utf8'))
const fingerprint = createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' }))
  .digest('hex')

if (fingerprint !== EXPECTED_PUBLIC_KEY_FINGERPRINT) {
  throw new Error(`Unexpected update public-key fingerprint: ${fingerprint}`)
}

console.log(`Release update public key verified: ${fingerprint}`)
