import express from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config, ROOT } from './config.ts'
import { db, budget, nowIso } from './db.ts'
import { detectBillingOverrides } from './claude.ts'
import { resolveClaudeCli } from './resolve-cli.ts'
import { newSession, nextQuestion, noteServed, type SessionState } from './select.ts'
import { toPublic, grade, type Response as AnswerResponse } from './present.ts'
import { recordMastery, getSchedule, saveSchedule, nextSchedule, qualityFrom, allMastery } from './mastery.ts'
import { readyCount, runBuffer, startBufferLoop, status as bufferStatus, generateNow } from './buffer.ts'
import { coach, describeResponse } from './coach.ts'
import { requireSubtopic, SUBTOPICS, type Section } from '../content/taxonomy.ts'
import { ERROR_TAGS, errorTagsFor } from '../content/errors.ts'
import type { StoredQuestion } from './store.ts'
import type { Generated } from './schemas.ts'

/**
 * The local server.
 *
 * It does two jobs: serve the interface, and be the only thing that knows the
 * answers. Sessions live in memory because this is a single-person tool running on
 * your own machine -- there is nothing to scale and nobody to share state with.
 */

const app = express()
app.use(express.json({ limit: '1mb' }))

const sessions = new Map<string, SessionState>()

function loadQuestion(id: string): StoredQuestion | null {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
    | {
        id: string
        section: string
        subtopic: string
        format: string
        difficulty: number
        payload: string
        explanation: string
        status: string
        reject_reason: string | null
        created_at: string
        first_served_at: string | null
      }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    section: row.section as Section,
    subtopic: row.subtopic,
    format: row.format as StoredQuestion['format'],
    difficulty: row.difficulty,
    payload: JSON.parse(row.payload) as Generated,
    explanation: row.explanation,
    status: row.status as StoredQuestion['status'],
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    firstServedAt: row.first_served_at,
  }
}

// -------------------------------------------------------------------------- status

app.get('/api/status', (_req, res) => {
  const overrides = detectBillingOverrides()
  let cliPath: string | null = null
  let cliError: string | null = null
  try {
    cliPath = resolveClaudeCli().foundAt
  } catch (e) {
    cliError = (e as Error).message
  }

  res.json({
    budget: budget(),
    buffer: bufferStatus(),
    ready: { quant: readyCount('quant'), verbal: readyCount('verbal') },
    claude: { path: cliPath, error: cliError, model: config.model },
    // These are stripped from every call, but worth surfacing so nothing is a surprise.
    billingOverridesIgnored: overrides,
  })
})

app.get('/api/mastery', (_req, res) => {
  const rows = allMastery().map((m) => {
    const sub = requireSubtopic(m.subtopic)
    return {
      subtopic: m.subtopic,
      label: sub.label,
      group: sub.group,
      section: sub.section,
      mean: m.mean,
      sd: m.sd,
      attempts: m.attempts,
    }
  })
  res.json({ mastery: rows })
})

app.get('/api/errors', (_req, res) => {
  const section = req_section(_req.query.section)
  res.json({ tags: section ? errorTagsFor(section) : ERROR_TAGS })
})

function req_section(v: unknown): Section | null {
  return v === 'quant' || v === 'verbal' ? v : null
}

// ------------------------------------------------------------------------ sessions

app.post('/api/session', (req, res) => {
  const raw = (req.body ?? {}) as { section?: string }
  const section = raw.section === 'quant' || raw.section === 'verbal' ? raw.section : 'both'
  const id = randomUUID()
  sessions.set(id, newSession(section))

  // Start filling the pool for whatever they picked, without blocking the response.
  void runBuffer(section).catch(() => undefined)

  res.json({ sessionId: id, section })
})

app.get('/api/session/:id/next', async (req, res) => {
  const state = sessions.get(req.params.id)
  if (!state) {
    res.status(404).json({ error: 'that study session has expired. Start a new one.' })
    return
  }

  const pick = nextQuestion(state)

  if (pick.kind === 'question') {
    const sub = requireSubtopic(pick.question.subtopic)
    noteServed(state, pick.question, pick.mode)
    void runBuffer(state.section).catch(() => undefined) // top up behind them
    res.json({ question: toPublic(pick.question, pick.mode, sub.label, sub.group) })
    return
  }

  // Nothing in stock. Make one now rather than showing an empty screen.
  if (budget().exhausted) {
    res.status(503).json({
      error: `You have used your ${budget().limit} Claude calls for today, and there are no ready questions left. Raise GRE_MAX_CALLS_PER_DAY in .env, or come back tomorrow.`,
    })
    return
  }

  const id = await generateNow(pick.wanted)
  if (!id) {
    res.status(503).json({ error: 'Could not produce a question just now. Try again in a moment.' })
    return
  }

  const made = loadQuestion(id)
  if (!made) {
    res.status(500).json({ error: 'question vanished after being written' })
    return
  }

  const sub = requireSubtopic(made.subtopic)
  noteServed(state, made, 'drill')
  void runBuffer(state.section).catch(() => undefined)
  res.json({ question: toPublic(made, 'drill', sub.label, sub.group) })
})

// -------------------------------------------------------------------------- answers

app.post('/api/session/:id/answer', (req, res) => {
  const state = sessions.get(req.params.id)
  if (!state) {
    res.status(404).json({ error: 'that study session has expired. Start a new one.' })
    return
  }

  const body = (req.body ?? {}) as { questionId?: string; response?: AnswerResponse; seconds?: number }
  if (!body.questionId || !body.response) {
    res.status(400).json({ error: 'questionId and response are required' })
    return
  }

  const q = loadQuestion(body.questionId)
  if (!q) {
    res.status(404).json({ error: 'no such question' })
    return
  }

  const seconds = Math.max(0, Number(body.seconds ?? 0))
  const result = grade(q.format, q.payload, body.response)

  db.prepare(
    'INSERT INTO attempts (question_id, mode, response, correct, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(q.id, 'drill', JSON.stringify(body.response), result.correct ? 1 : 0, seconds, nowIso())

  const attemptId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id

  recordMastery(q.subtopic, result.correct, q.difficulty)

  // Anything you get wrong enters the review schedule. Anything you get right and
  // already had scheduled moves further out.
  const existing = getSchedule(q.id)
  if (!result.correct || existing) {
    const quality = qualityFrom(result.correct, seconds, q.difficulty)
    saveSchedule(q.id, nextSchedule(existing, quality))
  }

  const sub = requireSubtopic(q.subtopic)
  res.json({
    attemptId,
    correct: result.correct,
    correctIndices: result.correctIndices,
    correctValue: result.correctValue,
    explanation: result.explanation,
    errorTags: result.correct ? [] : errorTagsFor(sub.section),
  })
})

app.post('/api/attempt/:id/tag', (req, res) => {
  const body = (req.body ?? {}) as { tag?: string }
  const valid = new Set(ERROR_TAGS.map((t) => t.id))
  if (!body.tag || !valid.has(body.tag)) {
    res.status(400).json({ error: 'unknown error tag' })
    return
  }
  db.prepare('UPDATE attempts SET error_tag = ? WHERE id = ?').run(body.tag, Number(req.params.id))
  res.json({ ok: true })
})

app.post('/api/coach', async (req, res) => {
  const body = (req.body ?? {}) as { questionId?: string; response?: unknown }
  if (!body.questionId) {
    res.status(400).json({ error: 'questionId is required' })
    return
  }
  const q = loadQuestion(body.questionId)
  if (!q) {
    res.status(404).json({ error: 'no such question' })
    return
  }

  const payload = q.payload as unknown as Record<string, unknown>
  const chosen = describeResponse(q.format, payload, body.response)
  const graded = grade(q.format, q.payload, body.response as AnswerResponse)

  const correctText =
    graded.correctValue !== undefined
      ? String(graded.correctValue)
      : describeResponse(q.format, payload, {
          kind: q.format === 'tc' ? 'blanks' : 'choice',
          indices: graded.correctIndices ?? [],
        })

  const result = await coach(q, body.response, chosen, correctText)
  if ('error' in result) {
    res.status(503).json(result)
    return
  }
  res.json(result)
})

// ----------------------------------------------------------------------- strategies

const STRATEGY_DIR = config.strategiesDir

app.get('/api/strategies', async (_req, res) => {
  if (!existsSync(STRATEGY_DIR)) {
    res.json({ strategies: [] })
    return
  }
  const files = (await readdir(STRATEGY_DIR)).filter((f) => f.endsWith('.md'))
  const strategies = await Promise.all(
    files.map(async (f) => {
      const text = await readFile(join(STRATEGY_DIR, f), 'utf8')
      const title = f.replace(/\.md$/, '')
      const tags = /^tags:\s*\[(.*?)\]/m.exec(text)?.[1] ?? ''
      const summary = /^summary:\s*(.*)$/m.exec(text)?.[1] ?? ''
      return { title, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), summary }
    }),
  )
  res.json({ strategies })
})

app.get('/api/strategies/:title', async (req, res) => {
  // Resolve and confirm the result is still inside the strategies directory, so a
  // crafted title cannot walk out of it and read arbitrary files.
  const target = resolve(STRATEGY_DIR, `${req.params.title}.md`)
  if (!target.startsWith(resolve(STRATEGY_DIR))) {
    res.status(400).json({ error: 'bad strategy name' })
    return
  }
  if (!existsSync(target)) {
    res.status(404).json({ error: 'no such strategy page' })
    return
  }
  res.json({ title: req.params.title, markdown: await readFile(target, 'utf8') })
})

app.get('/api/taxonomy', (_req, res) => {
  res.json({ subtopics: SUBTOPICS })
})

// ------------------------------------------------------------------ serve the app

const DIST = join(ROOT, 'dist')
if (existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(DIST, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send(
        'The interface has not been built yet.\n\n' +
          'For development, run `npm run dev` and open the address it prints.\n' +
          'For everyday use, run `npm run build` once, then `npm start`.\n',
      )
  })
}

const server = app.listen(config.port, () => {
  console.log(`GRE trainer running at http://localhost:${config.port}`)
  const b = budget()
  console.log(`Claude calls today: ${b.used}/${b.limit}`)
  console.log(`Questions ready: ${readyCount()}`)
})

const stopLoop = startBufferLoop('both')

function shutdown(): void {
  stopLoop()
  server.close(() => process.exit(0))
  // Do not hang forever if a Claude call is still in flight.
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
