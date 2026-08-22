import { db, nowIso } from './db.ts'
import { allMastery, needScore, dueQuestionIds, getMastery, type Mastery } from './mastery.ts'
import { subtopicsFor, requireSubtopic, type Difficulty, type Format, type Section } from '../content/taxonomy.ts'
import type { StoredQuestion } from './store.ts'
import type { Generated } from './schemas.ts'

/**
 * Choosing what to ask next.
 *
 * Three things are balanced:
 *
 *   - Weakness. Subtopics you are bad at, or that we have barely measured, come up
 *     more often (see needScore in mastery.ts).
 *   - Review. Questions you previously got wrong come back when they fall due.
 *   - Interleaving. Never more than a couple of questions from one subtopic in a
 *     row. Practising one topic in a block feels more productive and demonstrably
 *     works worse than mixing topics up.
 */

/** At most this share of a session is review rather than new material. */
const REVIEW_SHARE = 0.3

/** How many recent questions the interleaving rule looks back over. */
const INTERLEAVE_WINDOW = 3
const MAX_SAME_SUBTOPIC_IN_WINDOW = 1

export type SessionState = {
  section: Section | 'both'
  /** Subtopic ids of the last few questions served, most recent last. */
  recentSubtopics: string[]
  /** Question ids already served this session, so nothing repeats within a session. */
  servedIds: string[]
  /** How many of the questions served so far were reviews. */
  reviewsServed: number
  served: number
}

export function newSession(section: Section | 'both'): SessionState {
  return { section, recentSubtopics: [], servedIds: [], reviewsServed: 0, served: 0 }
}

/** Difficulty to aim for, from how well you are doing at that subtopic. */
export function targetDifficulty(m: Mastery): Difficulty {
  // Below 40% accuracy, drop to easy; above 85%, push to the top of the range.
  if (m.mean < 0.4) return 2
  if (m.mean < 0.55) return 3
  if (m.mean < 0.72) return 4
  if (m.mean < 0.85) return 4
  return 5
}

function eligibleSubtopics(state: SessionState): Mastery[] {
  const sections: Section[] = state.section === 'both' ? ['quant', 'verbal'] : [state.section]
  const ids = new Set(sections.flatMap((s) => subtopicsFor(s).map((t) => t.id)))

  const recent = state.recentSubtopics.slice(-INTERLEAVE_WINDOW)
  const overused = new Set(
    [...new Set(recent)].filter(
      (id) => recent.filter((r) => r === id).length >= MAX_SAME_SUBTOPIC_IN_WINDOW,
    ),
  )

  const all = allMastery().filter((m) => ids.has(m.subtopic))
  const allowed = all.filter((m) => !overused.has(m.subtopic))

  // If the interleaving rule excluded everything (a section with very few
  // subtopics), relax it rather than failing to serve a question.
  return allowed.length > 0 ? allowed : all
}

/**
 * Pick a subtopic, weighted by need.
 *
 * Weighted random rather than "always the weakest": always taking the weakest topic
 * would drill one thing to death and never revisit the others, and it makes a
 * session feel mechanical.
 */
export function chooseSubtopic(state: SessionState, random = Math.random): string {
  const candidates = eligibleSubtopics(state)
  if (candidates.length === 0) throw new Error('no subtopics available for this section')

  // Cubed so genuinely weak topics dominate without starving the rest.
  const weights = candidates.map((m) => Math.pow(needScore(m), 3) + 0.01)
  const total = weights.reduce((a, b) => a + b, 0)

  let roll = random() * total
  for (const [i, w] of weights.entries()) {
    roll -= w
    if (roll <= 0) return (candidates[i] as Mastery).subtopic
  }
  return (candidates[candidates.length - 1] as Mastery).subtopic
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

/**
 * An unseen verified question for this subtopic, as close as possible to the target
 * difficulty. Returns null when the pool is dry, which is the signal to generate.
 */
export function takeFromPool(subtopic: string, target: Difficulty, excludeIds: string[]): StoredQuestion | null {
  const placeholders = excludeIds.length > 0 ? excludeIds.map(() => '?').join(',') : "''"
  const row = db
    .prepare(
      `SELECT * FROM questions
       WHERE status = 'verified'
         AND subtopic = ?
         AND first_served_at IS NULL
         AND id NOT IN (${placeholders})
       ORDER BY ABS(difficulty - ?) ASC, created_at ASC
       LIMIT 1`,
    )
    .get(subtopic, ...excludeIds, target) as Row | undefined

  return row ? hydrate(row) : null
}

/** Any unseen verified question in the section, used when a specific bucket is dry. */
export function takeAnyFromPool(
  section: Section | 'both',
  excludeIds: string[],
  excludeSubtopics: string[] = [],
): StoredQuestion | null {
  const idPlaceholders = excludeIds.length > 0 ? excludeIds.map(() => '?').join(',') : "''"
  const subPlaceholders = excludeSubtopics.length > 0 ? excludeSubtopics.map(() => '?').join(',') : "''"
  const sectionClause = section === 'both' ? '' : 'AND section = ?'
  const params: string[] = [...excludeIds, ...excludeSubtopics]
  if (section !== 'both') params.push(section)

  const row = db
    .prepare(
      `SELECT * FROM questions
       WHERE status = 'verified'
         AND first_served_at IS NULL
         AND id NOT IN (${idPlaceholders})
         AND subtopic NOT IN (${subPlaceholders})
         ${sectionClause}
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(...params) as Row | undefined

  return row ? hydrate(row) : null
}

/** A question that has fallen due for review. */
export function takeDueReview(state: SessionState): StoredQuestion | null {
  const due = dueQuestionIds(20)
  const usable = due.filter((id) => !state.servedIds.includes(id))
  if (usable.length === 0) return null

  const placeholders = usable.map(() => '?').join(',')
  const sectionClause = state.section === 'both' ? '' : 'AND section = ?'
  const params: string[] = [...usable]
  if (state.section !== 'both') params.push(state.section)

  const row = db
    .prepare(`SELECT * FROM questions WHERE id IN (${placeholders}) ${sectionClause} LIMIT 1`)
    .get(...params) as Row | undefined

  return row ? hydrate(row) : null
}

export function markServed(questionId: string): void {
  db.prepare('UPDATE questions SET first_served_at = COALESCE(first_served_at, ?) WHERE id = ?').run(
    nowIso(),
    questionId,
  )
}

export type Pick =
  | { kind: 'question'; question: StoredQuestion; mode: 'drill' | 'review' }
  | { kind: 'empty'; wanted: { subtopic: string; format: Format; difficulty: Difficulty } }

/**
 * The next thing to show.
 *
 * When the pool has nothing suitable, this returns what it *wanted* rather than an
 * error, so the caller can ask the generator for exactly that and try again.
 */
export function nextQuestion(state: SessionState, random = Math.random): Pick {
  // Review first, but only up to its share of the session, so a backlog of due
  // items cannot crowd out new material entirely.
  const reviewShare = state.served === 0 ? 0 : state.reviewsServed / state.served
  if (reviewShare < REVIEW_SHARE) {
    const review = takeDueReview(state)
    if (review) return { kind: 'question', question: review, mode: 'review' }
  }

  const subtopic = chooseSubtopic(state, random)
  const target = targetDifficulty(getMastery(subtopic))

  const fromBucket = takeFromPool(subtopic, target, state.servedIds)
  if (fromBucket) return { kind: 'question', question: fromBucket, mode: 'drill' }

  // The bucket is dry. Anything unseen beats making you wait, but prefer a
  // different subtopic so interleaving still holds.
  const recent = state.recentSubtopics.slice(-INTERLEAVE_WINDOW)
  const anything = takeAnyFromPool(state.section, state.servedIds, recent)
  if (anything) return { kind: 'question', question: anything, mode: 'drill' }

  const sub = requireSubtopic(subtopic)
  const format = sub.formats[Math.floor(random() * sub.formats.length)] as Format
  return { kind: 'empty', wanted: { subtopic, format, difficulty: target } }
}

/** Record that a question was served, updating the interleaving window. */
export function noteServed(state: SessionState, q: StoredQuestion, mode: 'drill' | 'review'): void {
  state.servedIds.push(q.id)
  state.recentSubtopics.push(q.subtopic)
  state.served += 1
  if (mode === 'review') state.reviewsServed += 1
  markServed(q.id)
}
