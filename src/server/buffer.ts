import { db } from './db.ts'
import { config } from './config.ts'
import { budget } from './db.ts'
import { generateQuestion } from './generate.ts'
import { verifyQuestion } from './verify.ts'
import { saveQuestion, recentStems } from './store.ts'
import { allMastery, needScore, getMastery } from './mastery.ts'
import { targetDifficulty, sectionShare } from './select.ts'
import { requireSubtopic, subtopicsFor, type Difficulty, type Format, type Section } from '../content/taxonomy.ts'
import { fillDefinitions } from './vocab.ts'

/**
 * Keeping questions ready before you ask for them.
 *
 * Generating and verifying a question takes 30-60 seconds. Waiting that long
 * between questions would make the tool unusable, so instead a background worker
 * keeps a stock of verified, never-seen questions in the topics you are weakest at.
 * While you read question N it is preparing N+6, and you never see the delay.
 *
 * It is deliberately unhurried: a couple of questions in flight at a time, a pause
 * between rounds, and a hard stop at the daily call cap. This runs alongside your
 * normal Claude Code use and should not crowd it out.
 */

export type BufferStatus = {
  running: boolean
  lastRunAt: string | null
  generatedThisRun: number
  rejectedThisRun: number
  lastError: string | null
  /** Verified, unseen questions currently in stock. */
  ready: number
}

let running = false
let stop = false
let lastRunAt: string | null = null
let generatedThisRun = 0
let rejectedThisRun = 0
let lastError: string | null = null

export function readyCount(section?: Section): number {
  const clause = section ? 'AND section = ?' : ''
  const params = section ? [section] : []
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM questions
       WHERE status = 'verified' AND first_served_at IS NULL ${clause}`,
    )
    .get(...params) as { n: number }
  return row.n
}

function readyForSubtopic(subtopic: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM questions
       WHERE status = 'verified' AND first_served_at IS NULL AND subtopic = ?`,
    )
    .get(subtopic) as { n: number }
  return row.n
}

export function status(): BufferStatus {
  return { running, lastRunAt, generatedThisRun, rejectedThisRun, lastError, ready: readyCount() }
}

export type Refill = { subtopic: string; format: Format; difficulty: Difficulty }

/**
 * How deep a stock to keep per subtopic.
 *
 * In a single-section session that is just the configured depth. In a Mixed session
 * it is not, for two reasons:
 *
 *   - The sections get different shares of the questions (see sectionShare in
 *     select.ts): the one you are weaker at comes up more, so it needs more stock.
 *   - The sections have different numbers of subtopics: quant has 26 and verbal 13.
 *     The same share of questions spread over fewer buckets means each bucket comes
 *     up more often, so each needs a deeper stock.
 *
 * Together: the total kept for Mixed is the same as an even split would keep (the
 * configured depth over the larger section, twice), and each section gets its share
 * of that total, divided across its own subtopics. Never less than one per bucket,
 * so the section you are good at still has something ready when its turn comes.
 */
function depthFor(section: Section, base: number, mixed: boolean): number {
  if (!mixed) return base
  const counts = { quant: subtopicsFor('quant').length, verbal: subtopicsFor('verbal').length }
  const mixedTotal = 2 * base * Math.max(counts.quant, counts.verbal)
  const forThisSection = mixedTotal * sectionShare(section)
  return Math.max(1, Math.round(forThisSection / counts[section]))
}

/** The buckets of one section that are short of stock, most valuable first. */
function planForSection(section: Section, depth: number): Refill[] {
  const ids = new Set(subtopicsFor(section).map((t) => t.id))

  const ranked = allMastery()
    .filter((m) => ids.has(m.subtopic))
    .map((m) => ({ m, need: needScore(m), stock: readyForSubtopic(m.subtopic) }))
    .filter((r) => r.stock < depth)
    .sort((a, b) => b.need - a.need)

  const plan: Refill[] = []
  for (const r of ranked) {
    const sub = requireSubtopic(r.m.subtopic)
    const shortfall = depth - r.stock
    for (let i = 0; i < shortfall; i++) {
      const format = sub.formats[(r.stock + i) % sub.formats.length] as Format
      plan.push({ subtopic: sub.id, format, difficulty: targetDifficulty(getMastery(sub.id)) })
    }
  }
  return plan
}

/**
 * What to generate next, most valuable first.
 *
 * Buckets are ranked by how much you need the topic, and only those actually short
 * of stock are included. Format rotates through the ones the subtopic supports so a
 * topic does not fill up with nothing but multiple choice.
 *
 * For a Mixed session the two sections are merged by share rather than ranked as
 * one list. Ranking as one list would let quant, with twice the buckets, monopolise
 * the front of the queue. Instead, each next slot goes to whichever section is
 * furthest behind its share so far -- so if English gets 80% of the questions, about
 * four of every five questions written next are English too.
 */
export function refillPlan(section: Section | 'both', depth = config.bufferDepth): Refill[] {
  const mixed = section === 'both'
  if (!mixed) return planForSection(section, depthFor(section, depth, false))

  const lists = {
    verbal: planForSection('verbal', depthFor('verbal', depth, true)),
    quant: planForSection('quant', depthFor('quant', depth, true)),
  }
  const share = { verbal: sectionShare('verbal'), quant: sectionShare('quant') }
  const taken = { verbal: 0, quant: 0 }

  const plan: Refill[] = []
  while (taken.verbal < lists.verbal.length || taken.quant < lists.quant.length) {
    // Once one list is used up, the rest of the other follows.
    let next: Section
    if (taken.verbal >= lists.verbal.length) next = 'quant'
    else if (taken.quant >= lists.quant.length) next = 'verbal'
    else {
      // "Behind" means: items taken so far, measured against that section's share.
      // The section with the smaller ratio is the one that has had less than its due.
      next = (taken.verbal + 1) / share.verbal <= (taken.quant + 1) / share.quant ? 'verbal' : 'quant'
    }
    plan.push(lists[next][taken[next]] as Refill)
    taken[next] += 1
  }
  return plan
}

/** Generate and verify one question, storing it either way. */
async function makeOne(refill: Refill): Promise<'verified' | 'rejected' | 'error'> {
  const sub = requireSubtopic(refill.subtopic)

  const gen = await generateQuestion({
    subtopicId: refill.subtopic,
    format: refill.format,
    difficulty: refill.difficulty,
    avoid: recentStems(refill.subtopic, refill.format),
  })
  if (!gen.ok) {
    lastError = gen.error
    return 'error'
  }

  const verdict = await verifyQuestion(refill.format, gen.data)
  saveQuestion({
    section: sub.section,
    subtopic: refill.subtopic,
    format: refill.format,
    question: gen.data,
    verdict,
    model: config.model,
  })
  return verdict.status
}

/**
 * Top up the pool until every active bucket has stock, the daily cap is reached, or
 * `stopBuffer()` is called. Safe to call repeatedly; only one run happens at a time.
 */
export async function runBuffer(section: Section | 'both' = 'both', maxQuestions = 40): Promise<void> {
  if (running) return
  running = true
  stop = false
  generatedThisRun = 0
  rejectedThisRun = 0
  lastError = null

  try {
    let made = 0
    for (;;) {
      if (stop || made >= maxQuestions) break

      // Leave headroom: each question needs a generate call and a verify call.
      if (budget().remaining < 4) {
        lastError = `daily Claude call cap reached (${budget().used}/${budget().limit})`
        break
      }

      const plan = refillPlan(section)
      if (plan.length === 0) break

      // Two at a time. claude.ts caps concurrency anyway; this just keeps the
      // pipeline full without flooding it.
      const batch = plan.slice(0, 2)
      const results = await Promise.all(batch.map((r) => makeOne(r)))

      for (const r of results) {
        made++
        if (r === 'verified') generatedThisRun++
        else if (r === 'rejected') rejectedThisRun++
      }

      // If every attempt in a batch failed outright, something is wrong; do not
      // spin through the daily budget discovering that repeatedly.
      if (results.every((r) => r === 'error')) break
    }
  } finally {
    running = false
    lastRunAt = new Date().toISOString()
  }
}

export function stopBuffer(): void {
  stop = true
}

/**
 * Generate one question on demand, for when the pool is dry and somebody is waiting.
 * Returns the question id, or null if it could not be made.
 */
export async function generateNow(refill: Refill): Promise<string | null> {
  const sub = requireSubtopic(refill.subtopic)

  const gen = await generateQuestion({
    subtopicId: refill.subtopic,
    format: refill.format,
    difficulty: refill.difficulty,
    avoid: recentStems(refill.subtopic, refill.format),
  })
  if (!gen.ok) {
    lastError = gen.error
    return null
  }

  const verdict = await verifyQuestion(refill.format, gen.data)
  const id = saveQuestion({
    section: sub.section,
    subtopic: refill.subtopic,
    format: refill.format,
    question: gen.data,
    verdict,
    model: config.model,
  })
  return verdict.status === 'verified' ? id : null
}

/** Start the background top-up loop. Returns a function that stops it. */
export function startBufferLoop(section: Section | 'both' = 'both', intervalMs = 30_000): () => void {
  let timer: NodeJS.Timeout | null = null

  const tick = async () => {
    try {
      await runBuffer(section)
      // Defining a dozen collected words costs one call, so it rides along with
      // the question top-up rather than needing its own schedule.
      await fillDefinitions()
    } catch (e) {
      lastError = String(e)
    }
    if (timer !== null) timer = setTimeout(tick, intervalMs)
  }

  timer = setTimeout(tick, 1_000)
  // Do not hold the process open just for the buffer.
  timer.unref?.()

  return () => {
    stopBuffer()
    if (timer) clearTimeout(timer)
    timer = null
  }
}
