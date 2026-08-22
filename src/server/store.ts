import { randomUUID } from 'node:crypto'
import { db, nowIso } from './db.ts'
import type { Generated, GeneratedChoice, GeneratedComparison, GeneratedNumeric } from './schemas.ts'
import type { Format, Section } from '../content/taxonomy.ts'
import type { Verdict } from './verify.ts'

/**
 * Reading and writing questions.
 *
 * The question body is stored as JSON in one column rather than spread across a
 * table per format. Formats differ a lot (a reading passage and a numeric-entry
 * answer have almost nothing in common) and they only ever get read back whole.
 */

export type StoredQuestion = {
  id: string
  section: Section
  subtopic: string
  format: Format
  difficulty: number
  payload: Generated
  explanation: string
  status: 'draft' | 'verified' | 'rejected'
  rejectReason: string | null
  createdAt: string
  firstServedAt: string | null
}

const insert = db.prepare(`
  INSERT INTO questions (id, section, subtopic, format, difficulty, payload, answer,
                         explanation, check_expr, status, reject_reason, verifier_note,
                         model, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

/** The answer, pulled out of the payload so it can be queried without parsing JSON. */
function answerOf(format: Format, q: Generated): string {
  switch (format) {
    case 'ne':
      return String((q as GeneratedNumeric).correctValue)
    case 'qc':
      return (q as GeneratedComparison).relation
    default: {
      const withIndices = q as { correctIndices?: number[]; blanks?: Array<{ correctIndex: number }> }
      if (withIndices.blanks) return withIndices.blanks.map((b) => b.correctIndex).join(',')
      return (withIndices.correctIndices ?? []).join(',')
    }
  }
}

function checkExprOf(format: Format, q: Generated): string | null {
  if (format === 'ne') return (q as GeneratedNumeric).checkExpr
  if (format === 'mc') return (q as GeneratedChoice).checkExpr
  if (format === 'qc') {
    const d = q as GeneratedComparison
    return [d.checkA, d.checkB].filter(Boolean).join(' | ') || null
  }
  return null
}

export function saveQuestion(args: {
  section: Section
  subtopic: string
  format: Format
  question: Generated
  verdict: Verdict
  model: string
}): string {
  const id = randomUUID()
  const difficulty = (args.question as { difficulty?: number }).difficulty ?? 3
  const explanation = (args.question as { explanation?: string }).explanation ?? ''

  insert.run(
    id,
    args.section,
    args.subtopic,
    args.format,
    difficulty,
    JSON.stringify(args.question),
    answerOf(args.format, args.question),
    explanation,
    checkExprOf(args.format, args.question),
    args.verdict.status,
    args.verdict.reason ?? null,
    args.verdict.note ?? null,
    args.model,
    nowIso(),
  )
  return id
}

type Row = {
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

function hydrate(r: Row): StoredQuestion {
  return {
    id: r.id,
    section: r.section as Section,
    subtopic: r.subtopic,
    format: r.format as Format,
    difficulty: r.difficulty,
    payload: JSON.parse(r.payload) as Generated,
    explanation: r.explanation,
    status: r.status as StoredQuestion['status'],
    rejectReason: r.reject_reason,
    createdAt: r.created_at,
    firstServedAt: r.first_served_at,
  }
}

/** Recent stems in a bucket, handed to the generator so it does not repeat itself. */
export function recentStems(subtopic: string, format: Format, limit = 6): string[] {
  const rows = db
    .prepare('SELECT payload FROM questions WHERE subtopic = ? AND format = ? ORDER BY created_at DESC LIMIT ?')
    .all(subtopic, format, limit) as Array<{ payload: string }>

  return rows.map((r) => {
    const p = JSON.parse(r.payload) as { stem?: string; passage?: string }
    return (p.stem ?? p.passage ?? '').slice(0, 200)
  })
}

export function countByStatus(): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM questions GROUP BY status').all() as Array<{
    status: string
    n: number
  }>
  return Object.fromEntries(rows.map((r) => [r.status, r.n]))
}

export function listQuestions(status: string, limit = 50): StoredQuestion[] {
  const rows = db
    .prepare('SELECT * FROM questions WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(status, limit) as Row[]
  return rows.map(hydrate)
}
