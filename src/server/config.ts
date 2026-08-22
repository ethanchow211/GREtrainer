import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** Repo root, derived from this file's location so nothing hardcodes a drive letter. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const envFile = resolve(ROOT, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`)
  return n
}

function str(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim()
}

export const config = {
  maxCallsPerDay: num('GRE_MAX_CALLS_PER_DAY', 150),
  model: str('GRE_MODEL', 'sonnet'),
  bufferDepth: num('GRE_BUFFER_DEPTH', 5),
  callTimeoutSec: num('GRE_CALL_TIMEOUT_SEC', 120),
  port: num('GRE_PORT', 5174),
  // Overridable so tests can run against a scratch database instead of your real
  // progress. Not something you would normally set.
  dbPath: str('GRE_DB_PATH', resolve(ROOT, 'data', 'gre.db')),
  strategiesDir: resolve(ROOT, 'content', 'strategies'),
} as const
