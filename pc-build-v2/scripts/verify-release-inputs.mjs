import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const EXPECTED_PUBLIC_KEY_FINGERPRINT =
  '8be2a82e869112c3d67de63f0f60ee0d6beb057eb9b160d8effad92098a60b0d'
const publicKeyPath = resolve(import.meta.dirname, '../resources/update-public-key.pem')

const publicKey = createPublicKey(await readFile(publicKeyPath, 'utf8'))
const fingerprint = createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' }))
  .digest('hex')

if (fingerprint !== EXPECTED_PUBLIC_KEY_FINGERPRINT) {
  throw new Error(`Unexpected update public-key fingerprint: ${fingerprint}`)
}

console.log(`Release update public key verified: ${fingerprint}`)
