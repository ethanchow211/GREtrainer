import { spawn } from 'node:child_process'
import { config, ROOT } from './config.ts'
import { resolveClaudeCli } from './resolve-cli.ts'

/**
 * Transport layer for talking to Claude.
 *
 * We shell out to the `claude` command rather than calling an HTTP API, because that
 * is the only supported way to use a Claude Code *subscription* instead of
 * pay-per-token API billing. The credentials live in ~/.claude/.credentials.json and
 * only the CLI knows how to read them.
 *
 * Every call is deliberately "lean": no tools, no MCP servers, no settings files, no
 * skills, and a replaced (not appended) system prompt. Measured on this machine that
 * drops per-call overhead from ~45,000 tokens to ~1,300 -- roughly 10x less
 * subscription quota per question, and about twice as fast.
 */

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /** What this call would have cost on the pay-per-token API. A proxy for how hard
   *  we are leaning on the subscription. Not an actual charge. */
  notionalCostUsd: number
  durationMs: number
}

export type CallOk<T> = { ok: true; data: T; usage: Usage }
export type CallErr = {
  ok: false
  error: string
  stage: 'spawn' | 'timeout' | 'cli' | 'parse'
  usage?: Usage
}
export type CallResult<T> = CallOk<T> | CallErr

export type CallOptions = {
  /** Replaces the default Claude Code system prompt entirely. */
  system: string
  prompt: string
  /** JSON Schema the reply must satisfy. The CLI enforces this, so we get structured
   *  data back instead of parsing prose. */
  schema: Record<string, unknown>
  model?: string
  timeoutSec?: number
}

/**
 * Environment variables that would silently redirect a call away from the
 * subscription and onto a billed account. We strip all of them from the child
 * process, so setting one of these for an unrelated project can never quietly start
 * charging per token for GRE questions.
 */
const BILLING_OVERRIDE_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of BILLING_OVERRIDE_VARS) delete env[key]
  return env
}

/** Anything in the current environment that would have forced billed API usage. */
export function detectBillingOverrides(): string[] {
  return BILLING_OVERRIDE_VARS.filter((k) => {
    const v = process.env[k]
    return v !== undefined && v.trim() !== ''
  })
}

// Only a couple of Claude processes at once. Each is a full CLI start-up; a dozen in
// parallel makes the machine unhappy without making anything faster.
const MAX_CONCURRENT = 2
let active = 0
const waiting: Array<() => void> = []

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return
  }
  await new Promise<void>((res) => waiting.push(res))
  active++
}

function releaseSlot(): void {
  active--
  const next = waiting.shift()
  if (next) next()
}

type CliEnvelope = {
  is_error?: boolean
  subtype?: string
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  api_error_status?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

function runOnce<T>(opts: CallOptions): Promise<CallResult<T>> {
  const timeoutMs = (opts.timeoutSec ?? config.callTimeoutSec) * 1000

  const args = [
    '--print',
    '--output-format',
    'json',
    '--model',
    opts.model ?? config.model,
    '--system-prompt',
    opts.system,
    '--json-schema',
    JSON.stringify(opts.schema),
    // Everything below strips context we neither want nor wish to pay for.
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
  ]

  return new Promise((resolve) => {
    const started = Date.now()

    let cli
    try {
      cli = resolveClaudeCli()
    } catch (e) {
      resolve({ ok: false, stage: 'spawn', error: (e as Error).message })
      return
    }

    // shell:false is not optional. A shell concatenates arguments without escaping,
    // which both drops our empty-string flags (`--tools ""`) and would make the
    // prompt text shell-injectable.
    const child = spawn(cli.command, [...cli.prefixArgs, ...args], {
      env: childEnv(),
      cwd: ROOT,
      shell: false,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (r: CallResult<T>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish({
        ok: false,
        stage: 'timeout',
        error: `claude did not answer within ${timeoutMs / 1000}s`,
      })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout += d
    })
    child.stderr.on('data', (d: string) => {
      stderr += d
    })

    child.on('error', (e) => {
      finish({ ok: false, stage: 'spawn', error: `could not start claude: ${e.message}` })
    })

    child.on('close', (code) => {
      let env: CliEnvelope
      try {
        env = JSON.parse(stdout)
      } catch {
        finish({
          ok: false,
          stage: 'cli',
          error: `claude exited ${code} without valid JSON. stderr: ${stderr.slice(0, 500)}`,
        })
        return
      }

      const usage: Usage = {
        inputTokens: env.usage?.input_tokens ?? 0,
        outputTokens: env.usage?.output_tokens ?? 0,
        cacheCreationTokens: env.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: env.usage?.cache_read_input_tokens ?? 0,
        notionalCostUsd: env.total_cost_usd ?? 0,
        durationMs: env.duration_ms ?? Date.now() - started,
      }

      if (env.is_error || env.subtype !== 'success') {
        finish({
          ok: false,
          stage: 'cli',
          error: `claude reported an error: ${env.subtype ?? 'unknown'} ${
            env.api_error_status ?? ''
          } ${String(env.result ?? '').slice(0, 300)}`,
          usage,
        })
        return
      }

      const text = (env.result ?? '').trim()
      // --json-schema should return bare JSON, but tolerating a fenced block is
      // cheaper than discarding an otherwise good question.
      const unfenced = text.startsWith('```')
        ? text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
        : text

      try {
        finish({ ok: true, data: JSON.parse(unfenced) as T, usage })
      } catch {
        finish({
          ok: false,
          stage: 'parse',
          error: `reply was not JSON: ${unfenced.slice(0, 300)}`,
          usage,
        })
      }
    })

    child.stdin.on('error', () => {
      /* closed early; the close handler reports the real failure */
    })
    child.stdin.end(opts.prompt, 'utf8')
  })
}

/**
 * Make one Claude call, retrying once if the failure looks transient.
 *
 * A schema-shaped reply comes back as a plain object, but callers must still
 * validate it: a reply can satisfy the schema and still be nonsense.
 */
export async function callClaude<T>(opts: CallOptions): Promise<CallResult<T>> {
  await acquireSlot()
  try {
    const first = await runOnce<T>(opts)
    if (first.ok) return first
    if (first.stage === 'spawn') return first // retrying a missing binary is pointless

    const second = await runOnce<T>(opts)
    if (!second.ok) {
      return { ...second, error: `${second.error} (after retry; first attempt: ${first.error})` }
    }
    return second
  } finally {
    releaseSlot()
  }
}
