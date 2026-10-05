import { callClaude } from './claude.ts'
import { db, nowIso, recordCall, budget } from './db.ts'
import { config } from './config.ts'
import { QC_OPTIONS, requireSubtopic, type Format } from '../content/taxonomy.ts'
import { errorTagsFor } from '../content/errors.ts'
import type { StoredQuestion } from './store.ts'

/**
 * A short, personal note about the mistake you just made.
 *
 * The stored explanation says why the right answer is right. That is not the same as
 * telling you why *your* answer was tempting, which is the part that changes what you
 * do next time.
 *
 * Notes are cached per question and per wrong answer, so re-reviewing something
 * costs nothing. The model also picks the error tag, which then arrives in the
 * interface pre-selected -- recording why you missed a question becomes one click
 * instead of a form.
 */

const COACH_SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: { type: 'string' },
    errorTag: { type: 'string' },
    nextTime: { type: 'string' },
  },
  required: ['diagnosis', 'errorTag', 'nextTime'],
  additionalProperties: false,
} as const

export type Coaching = {
  diagnosis: string
  errorTag: string
  nextTime: string
  cached: boolean
}

function cacheKey(response: unknown, format?: Format): string {
  const responseJson = JSON.stringify(response)

  // Older QC notes were generated before the fixed choices were translated
  // into words. Give only those notes a new key so a previously incorrect note
  // is regenerated, while valid coaching for every other format stays cached.
  return format === 'qc' ? `qc-v2:${responseJson}` : responseJson
}

export function getCached(questionId: string, response: unknown, format?: Format): Coaching | null {
  const row = db
    .prepare('SELECT note FROM coaching WHERE question_id = ? AND response_key = ?')
    .get(questionId, cacheKey(response, format)) as { note: string } | undefined
  if (!row) return null
  try {
    return { ...(JSON.parse(row.note) as Omit<Coaching, 'cached'>), cached: true }
  } catch {
    return null
  }
}

function save(questionId: string, response: unknown, format: Format, c: Omit<Coaching, 'cached'>): void {
  db.prepare(
    `INSERT INTO coaching (question_id, response_key, note, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(question_id, response_key) DO UPDATE SET note = excluded.note`,
  ).run(questionId, cacheKey(response, format), JSON.stringify(c), nowIso())
}

/** A plain-text rendering of what was asked and what was picked. */
function describe(q: StoredQuestion, chosenText: string, correctText: string): string {
  const p = q.payload as Record<string, unknown>
  const parts: string[] = []

  if (typeof p.passage === 'string') parts.push(`Passage:\n${p.passage}`)
  if (typeof p.stem === 'string' && p.stem.trim()) parts.push(`Question:\n${p.stem}`)
  if (typeof p.quantityA === 'string') {
    parts.push(`Quantity A: ${p.quantityA}\nQuantity B: ${p.quantityB as string}`)
  }
  if (Array.isArray(p.options)) {
    parts.push(`Options:\n${(p.options as string[]).map((o, i) => `${i + 1}. ${o}`).join('\n')}`)
  }

  parts.push(`They chose: ${chosenText}`)
  parts.push(`The correct answer: ${correctText}`)
  parts.push(`The official explanation: ${q.explanation}`)
  return parts.join('\n\n')
}

export async function coach(
  q: StoredQuestion,
  response: unknown,
  chosenText: string,
  correctText: string,
): Promise<Coaching | { error: string }> {
  const cached = getCached(q.id, response, q.format)
  if (cached) return cached

  if (budget().exhausted) {
    return { error: 'daily Claude call limit reached, so no personalised note this time' }
  }

  const sub = requireSubtopic(q.subtopic)
  const tags = errorTagsFor(sub.section)

  const system = `You are a GRE tutor. A student has just answered a question incorrectly.
You are given the question, their answer, the correct answer, and the official
explanation.

Write a short, direct diagnosis of what went wrong FOR THIS STUDENT. Do not restate
the explanation -- they can already read that. Say what made their specific wrong
answer tempting, and what would have caught it.

Rules:
- "diagnosis": at most three sentences. Address them as "you". Be concrete about
  their answer, not general about the topic.
- "nextTime": one sentence, an action they can take on the next question of this
  kind. A habit, not a fact.
- "errorTag": choose the single id from this list that best explains the mistake:
${tags.map((t) => `    ${t.id} -- ${t.label}: ${t.hint}`).join('\n')}
- No praise, no preamble, no "great question". Just the diagnosis.`

  const res = await callClaude<{ diagnosis: string; errorTag: string; nextTime: string }>({
    system,
    prompt: describe(q, chosenText, correctText),
    schema: COACH_SCHEMA as unknown as Record<string, unknown>,
  })

  recordCall({
    purpose: 'coach',
    model: config.model,
    ok: res.ok,
    inputTokens: res.usage?.inputTokens,
    outputTokens: res.usage?.outputTokens,
    cacheTokens: (res.usage?.cacheCreationTokens ?? 0) + (res.usage?.cacheReadTokens ?? 0),
    costUsd: res.usage?.notionalCostUsd,
    durationMs: res.usage?.durationMs,
    error: res.ok ? undefined : res.error,
  })

  if (!res.ok) return { error: res.error }

  // Guard against a tag the model invented rather than chose.
  const valid = new Set(tags.map((t) => t.id))
  const errorTag = valid.has(res.data.errorTag) ? res.data.errorTag : 'careless-other'

  const note = { diagnosis: res.data.diagnosis, errorTag, nextTime: res.data.nextTime }
  save(q.id, response, q.format, note)
  return { ...note, cached: false }
}

/** Format helper: how a response reads in prose, for the coaching prompt. */
export function describeResponse(format: Format, payload: Record<string, unknown>, response: unknown): string {
  const r = response as { kind?: string; indices?: number[]; value?: string }

  if (r.kind === 'numeric') return String(r.value ?? '')

  if (format === 'tc') {
    const blanks = payload.blanks as Array<{ options: string[] }> | undefined
    if (!blanks || !r.indices) return JSON.stringify(response)
    return r.indices.map((idx, i) => `blank ${i + 1}: "${blanks[i]?.options[idx] ?? '?'}"`).join(', ')
  }

  // Quantitative Comparison choices are fixed and therefore are not stored in
  // the generated payload. Translate their indices explicitly so the coach sees
  // "The relationship cannot be determined..." instead of opaque JSON such as
  // {"indices":[3]}.
  if (format === 'qc' && r.indices) {
    return r.indices.map((index) => `"${QC_OPTIONS[index] ?? '?'}"`).join(' and ')
  }

  const options = payload.options as string[] | undefined
  if (options && r.indices) return r.indices.map((i) => `"${options[i] ?? '?'}"`).join(' and ')

  return JSON.stringify(response)
}
