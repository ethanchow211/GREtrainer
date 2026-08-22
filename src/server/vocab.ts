import { callClaude } from './claude.ts'
import { db, nowIso, recordCall, budget } from './db.ts'
import { config } from './config.ts'
import { nextSchedule, type ScheduleState } from './mastery.ts'
import type { StoredQuestion } from './store.ts'
import type { GeneratedSentenceEquivalence, GeneratedTextCompletion } from './schemas.ts'

/**
 * The vocabulary deck.
 *
 * Words arrive by themselves: miss a Text Completion or Sentence Equivalence
 * question and every word it offered goes into the deck. That is the right source,
 * because those are words that have already cost you a point rather than words from
 * somebody's generic list.
 *
 * Definitions are filled in lazily and in batches -- up to a dozen words per Claude
 * call -- so building the deck is close to free. A word sits in the deck with no
 * definition until then, which is harmless because it is not due yet anyway.
 */

export type VocabCard = {
  word: string
  definition: string
  seenIn: string | null
  dueAt: string
  intervalDays: number
  ease: number
  reps: number
  lapses: number
}

type Row = {
  word: string
  definition: string
  seen_in: string | null
  due_at: string
  interval_days: number
  ease: number
  reps: number
  lapses: number
}

function hydrate(r: Row): VocabCard {
  return {
    word: r.word,
    definition: r.definition,
    seenIn: r.seen_in,
    dueAt: r.due_at,
    intervalDays: r.interval_days,
    ease: r.ease,
    reps: r.reps,
    lapses: r.lapses,
  }
}

/** Words are stored lowercase and trimmed, so the same word never lands twice. */
function normalise(word: string): string {
  return word.trim().toLowerCase().replace(/[^a-z-]/g, '')
}

/**
 * Pull the candidate words out of a verbal question.
 *
 * Every option is taken, not just the correct one: on Sentence Equivalence the trap
 * pair is exactly the vocabulary worth learning, and on Text Completion the wrong
 * options are usually the words that made it hard.
 */
export function wordsFrom(q: StoredQuestion): string[] {
  const words: string[] = []

  if (q.format === 'se') {
    words.push(...(q.payload as GeneratedSentenceEquivalence).options)
  } else if (q.format === 'tc') {
    for (const blank of (q.payload as GeneratedTextCompletion).blanks) words.push(...blank.options)
  }

  return [...new Set(words.map(normalise))].filter((w) => w.length >= 4)
}

/** Add words to the deck. Already-known words keep their schedule untouched. */
export function addWords(words: string[], seenIn: string | null): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO vocab (word, definition, seen_in, due_at, interval_days, ease, reps, lapses, created_at)
     VALUES (?, '', ?, ?, 0, 2.5, 0, 0, ?)`,
  )

  let added = 0
  const now = nowIso()
  for (const word of words) {
    const { changes } = insert.run(word, seenIn, now, now)
    if (Number(changes) > 0) added++
  }
  return added
}

export function harvestFrom(q: StoredQuestion): number {
  if (q.format !== 'se' && q.format !== 'tc') return 0
  return addWords(wordsFrom(q), q.id)
}

// ------------------------------------------------------------------- definitions

const DEFINE_SCHEMA = {
  type: 'object',
  properties: {
    definitions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          word: { type: 'string' },
          definition: { type: 'string' },
          /** Positive, negative, or neutral -- the thing that actually eliminates options. */
          charge: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
          example: { type: 'string' },
        },
        required: ['word', 'definition', 'charge', 'example'],
        additionalProperties: false,
      },
    },
  },
  required: ['definitions'],
  additionalProperties: false,
} as const

export function pendingWords(limit = 12): string[] {
  const rows = db
    .prepare("SELECT word FROM vocab WHERE definition = '' ORDER BY created_at ASC LIMIT ?")
    .all(limit) as Array<{ word: string }>
  return rows.map((r) => r.word)
}

/**
 * Define up to a dozen pending words in one call.
 *
 * Batching matters: one call for twelve words rather than twelve calls is the
 * difference between the deck being free to build and it eating the daily budget.
 */
export async function fillDefinitions(): Promise<number> {
  const words = pendingWords()
  if (words.length === 0) return 0
  if (budget().remaining < 2) return 0

  const system = `You define words for a GRE vocabulary deck.

For each word give:
- "definition": one clear sentence. Plain English, no circular definitions, and if
  the word has a secondary sense the GRE actually tests, give THAT sense.
- "charge": whether the word is positive, negative, or neutral in connotation. This
  is what lets someone eliminate options without knowing a precise meaning.
- "example": one short sentence using the word in the register the GRE uses --
  academic prose, not casual speech.

Define every word given, in the same order.`

  const res = await callClaude<{
    definitions: Array<{ word: string; definition: string; charge: string; example: string }>
  }>({
    system,
    prompt: words.join('\n'),
    schema: DEFINE_SCHEMA as unknown as Record<string, unknown>,
  })

  recordCall({
    purpose: 'vocab',
    model: config.model,
    ok: res.ok,
    inputTokens: res.usage?.inputTokens,
    outputTokens: res.usage?.outputTokens,
    cacheTokens: (res.usage?.cacheCreationTokens ?? 0) + (res.usage?.cacheReadTokens ?? 0),
    costUsd: res.usage?.notionalCostUsd,
    durationMs: res.usage?.durationMs,
    error: res.ok ? undefined : res.error,
  })

  if (!res.ok) return 0

  const update = db.prepare('UPDATE vocab SET definition = ? WHERE word = ?')
  let filled = 0
  const known = new Set(words)

  for (const d of res.data.definitions) {
    const word = normalise(d.word)
    // Only accept definitions for words we actually asked about.
    if (!known.has(word)) continue
    const text = `${d.definition} (${d.charge})\n\n${d.example}`
    update.run(text, word)
    filled++
  }
  return filled
}

// -------------------------------------------------------------------- reviewing

export function dueCards(limit = 20, now = new Date()): VocabCard[] {
  const rows = db
    .prepare("SELECT * FROM vocab WHERE definition != '' AND due_at <= ? ORDER BY due_at ASC LIMIT ?")
    .all(now.toISOString(), limit) as Row[]
  return rows.map(hydrate)
}

export function vocabStats(): { total: number; due: number; pending: number; learned: number } {
  const one = (sql: string, ...params: Array<string | number>): number =>
    (db.prepare(sql).get(...params) as { n: number }).n

  return {
    total: one('SELECT COUNT(*) AS n FROM vocab'),
    due: one("SELECT COUNT(*) AS n FROM vocab WHERE definition != '' AND due_at <= ?", nowIso()),
    pending: one("SELECT COUNT(*) AS n FROM vocab WHERE definition = ''"),
    learned: one('SELECT COUNT(*) AS n FROM vocab WHERE reps >= 3'),
  }
}

/** Record a review. `knew` maps onto the same SM-2 scale the question scheduler uses. */
export function reviewCard(word: string, knew: 'no' | 'hard' | 'yes'): VocabCard | null {
  const row = db.prepare('SELECT * FROM vocab WHERE word = ?').get(word) as Row | undefined
  if (!row) return null

  const prev: ScheduleState = {
    intervalDays: row.interval_days,
    ease: row.ease,
    reps: row.reps,
    lapses: row.lapses,
    dueAt: row.due_at,
  }

  const quality = knew === 'yes' ? 5 : knew === 'hard' ? 3 : 1
  const next = nextSchedule(prev, quality)

  db.prepare(
    'UPDATE vocab SET due_at = ?, interval_days = ?, ease = ?, reps = ?, lapses = ? WHERE word = ?',
  ).run(next.dueAt, next.intervalDays, next.ease, next.reps, next.lapses, word)

  return hydrate({
    ...row,
    due_at: next.dueAt,
    interval_days: next.intervalDays,
    ease: next.ease,
    reps: next.reps,
    lapses: next.lapses,
  })
}
