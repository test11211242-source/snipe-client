import { describe, expect, it } from 'vitest'

import { pythonWorkerEnvironment } from './python-environment'

describe('pythonWorkerEnvironment', () => {
  it('pins numeric thread pools to one thread and keeps the parent environment', () => {
    const environment = pythonWorkerEnvironment({ PYTHONUNBUFFERED: '1' })
    expect(environment).toMatchObject({
      OPENBLAS_NUM_THREADS: '1',
      OMP_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      PYTHONUNBUFFERED: '1',
    })
    expect(environment['PATH'] ?? environment['Path']).toBe(
      process.env['PATH'] ?? process.env['Path'],
    )
  })
})
