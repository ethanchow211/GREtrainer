import { db, nowIso } from './db.ts'
import { SUBTOPICS } from '../content/taxonomy.ts'

/**
 * Tracking what you are actually good at, and when to show you something again.
 *
 * Two independent ideas live here.
 *
 * ------------------------------------------------------------------ mastery
 * Percent-correct is useless at small sample sizes. Two out of three is 67%, and
 * so is two hundred out of three hundred, but only one of those is worth acting on.
 *
 * So each subtopic carries a Beta distribution instead: two numbers, alpha and beta,
 * which you can read as "successes so far" and "failures so far", started at 2 and 2
 * so nothing begins at a confident 0% or 100%. The mean alpha/(alpha+beta) is the
 * skill estimate, and the spread of the distribution is the uncertainty on it.
 * Answering a question adds 1 to whichever side it belongs on.
 *
 * The payoff is that "weak" and "unmeasured" become distinguishable, which is what
 * lets question selection explore instead of hammering the first topic you missed.
 *
 * ------------------------------------------------------------------ scheduling
 * Missed questions come back on an SM-2 schedule -- the algorithm behind Anki. Get
 * something right and the gap until you next see it grows; get it wrong and the gap
 * collapses back to a day and the item gets marginally harder to graduate.
 */

// ---------------------------------------------------------------------- mastery

export type Mastery = {
  subtopic: string
  alpha: number
  beta: number
  attempts: number
  /** Point estimate of your accuracy on this subtopic, between 0 and 1. */
  mean: number
  /** Standard deviation of the estimate. Large means we have not measured you much. */
  sd: number
}

const PRIOR_ALPHA = 2
const PRIOR_BETA = 2

function hydrate(subtopic: string, alpha: number, beta: number, attempts: number): Mastery {
  const n = alpha + beta
  const mean = alpha / n
  // Standard deviation of a Beta distribution.
  const sd = Math.sqrt((alpha * beta) / (n * n * (n + 1)))
  return { subtopic, alpha, beta, attempts, mean, sd }
}

export function getMastery(subtopic: string): Mastery {
  const row = db.prepare('SELECT alpha, beta, attempts FROM mastery WHERE subtopic = ?').get(subtopic) as
    | { alpha: number; beta: number; attempts: number }
    | undefined
  if (!row) return hydrate(subtopic, PRIOR_ALPHA, PRIOR_BETA, 0)
  return hydrate(subtopic, row.alpha, row.beta, row.attempts)
}

export function allMastery(): Mastery[] {
  return SUBTOPICS.map((s) => getMastery(s.id))
}

/**
 * Fold one answered question into the estimate for its subtopic.
 *
 * Harder questions carry more weight, because getting a difficulty-5 question right
 * says more about you than getting a difficulty-1 right. The weight is modest on
 * purpose -- this is a nudge, not a scoring model.
 */
export function recordMastery(subtopic: string, correct: boolean, difficulty = 3): Mastery {
  const weight = 0.75 + 0.125 * difficulty // 0.875 at difficulty 1, 1.375 at difficulty 5
  const current = getMastery(subtopic)

  const alpha = current.alpha + (correct ? weight : 0)
  const beta = current.beta + (correct ? 0 : weight)
  const attempts = current.attempts + 1

  db.prepare(
    `INSERT INTO mastery (subtopic, alpha, beta, attempts, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(subtopic) DO UPDATE SET
       alpha = excluded.alpha, beta = excluded.beta,
       attempts = excluded.attempts, updated_at = excluded.updated_at`,
  ).run(subtopic, alpha, beta, attempts, nowIso())

  return hydrate(subtopic, alpha, beta, attempts)
}

/**
 * How badly this subtopic needs attention, from 0 to roughly 1.
 *
 * Two things earn attention: being bad at something, and not knowing whether you are
 * bad at it. Weighting both means a topic you have never touched competes with one
 * you have measurably failed, so selection explores rather than fixating.
 */
export function needScore(m: Mastery): number {
  const weakness = 1 - m.mean
  const uncertainty = m.sd / 0.25 // 0.25 is roughly the sd of the Beta(2,2) prior
  return 0.7 * weakness + 0.3 * Math.min(1, uncertainty)
}

// -------------------------------------------------------------------- scheduling

export type ScheduleState = {
  intervalDays: number
  ease: number
  reps: number
  lapses: number
  dueAt: string
}

const MIN_EASE = 1.3
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * One SM-2 step.
 *
 * `quality` is how well it went, 0 to 5. We map answers onto it: a confident correct
 * answer is 5, a slow correct answer 3, anything wrong is 2 or below, and below 3 is
 * what SM-2 calls a lapse.
 */
export function nextSchedule(prev: ScheduleState | null, quality: number, now = new Date()): ScheduleState {
  const q = Math.max(0, Math.min(5, quality))
  const state: ScheduleState = prev ?? { intervalDays: 0, ease: 2.5, reps: 0, lapses: 0, dueAt: now.toISOString() }

  let { intervalDays, ease, reps, lapses } = state

  if (q < 3) {
    // Lapse: back to tomorrow, and the item gets slightly harder to graduate.
    reps = 0
    lapses += 1
    intervalDays = 1
    ease = Math.max(MIN_EASE, ease - 0.2)
  } else {
    reps += 1
    if (reps === 1) intervalDays = 1
    else if (reps === 2) intervalDays = 6
    else intervalDays = Math.round(intervalDays * ease * 10) / 10

    // The standard SM-2 ease update: a 5 nudges it up, a 3 pulls it down.
    ease = Math.max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
  }

  return {
    intervalDays,
    ease: Math.round(ease * 1000) / 1000,
    reps,
    lapses,
    dueAt: new Date(now.getTime() + intervalDays * DAY_MS).toISOString(),
  }
}

/** Turn an answer into an SM-2 quality score. */
export function qualityFrom(correct: boolean, seconds: number, difficulty: number): number {
  if (!correct) return seconds > 120 ? 1 : 2
  // A generous par time that grows with difficulty: 45s at difficulty 1, 105s at 5.
  const par = 30 + 15 * difficulty
  if (seconds <= par * 0.6) return 5
  if (seconds <= par) return 4
  return 3
}

export function getSchedule(questionId: string): ScheduleState | null {
  const row = db
    .prepare('SELECT interval_days, ease, reps, lapses, due_at FROM review_schedule WHERE question_id = ?')
    .get(questionId) as
    | { interval_days: number; ease: number; reps: number; lapses: number; due_at: string }
    | undefined
  if (!row) return null
  return {
    intervalDays: row.interval_days,
    ease: row.ease,
    reps: row.reps,
    lapses: row.lapses,
    dueAt: row.due_at,
  }
}

export function saveSchedule(questionId: string, s: ScheduleState): void {
  db.prepare(
    `INSERT INTO review_schedule (question_id, due_at, interval_days, ease, reps, lapses)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(question_id) DO UPDATE SET
       due_at = excluded.due_at, interval_days = excluded.interval_days,
       ease = excluded.ease, reps = excluded.reps, lapses = excluded.lapses`,
  ).run(questionId, s.dueAt, s.intervalDays, s.ease, s.reps, s.lapses)
}

export function dueQuestionIds(limit = 20, now = new Date()): string[] {
  const rows = db
    .prepare('SELECT question_id FROM review_schedule WHERE due_at <= ? ORDER BY due_at ASC LIMIT ?')
    .all(now.toISOString(), limit) as Array<{ question_id: string }>
  return rows.map((r) => r.question_id)
}
