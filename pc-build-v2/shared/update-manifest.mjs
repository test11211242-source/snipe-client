const PAYLOAD_KEYS = [
  'schemaVersion',
  'channel',
  'version',
  'publishedAt',
  'minimumVersion',
  'critical',
  'notes',
  'artifact',
]

const ARTIFACT_KEYS = ['fileName', 'size', 'sha512', 'url']

function serializeObject(value, keys) {
  const fields = []
  for (const key of keys) {
    if (value[key] !== undefined)
      fields.push(`${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
  }
  return `{${fields.join(',')}}`
}

export function canonicalizeUpdatePayload(payload) {
  const artifact = serializeObject(payload.artifact, ARTIFACT_KEYS)
  const fields = []
  for (const key of PAYLOAD_KEYS) {
    if (key === 'artifact') fields.push(`${JSON.stringify(key)}:${artifact}`)
    else if (payload[key] !== undefined)
      fields.push(`${JSON.stringify(key)}:${JSON.stringify(payload[key])}`)
  }
  return `{${fields.join(',')}}`
}
