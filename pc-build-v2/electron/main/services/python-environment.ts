/**
 * Environment for every spawned Python worker. NumPy's OpenBLAS (and any OpenMP/MKL
 * build) otherwise reserves a thread pool per core at import: ~690 MB of commit per
 * process on a 20-thread CPU, against ~22 MB with one thread (audit 14.10.2026). The
 * workers process small frames and never need parallel BLAS.
 */
export function pythonWorkerEnvironment(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENBLAS_NUM_THREADS: '1',
    OMP_NUM_THREADS: '1',
    MKL_NUM_THREADS: '1',
    ...extra,
  }
}
