import { randomUUID } from 'node:crypto'
import { db, nowIso } from './db.ts'
import { EXAM_SECTIONS, requireSubtopic, type Section } from '../content/taxonomy.ts'
import { toPublic, grade, type PublicQuestion, type Response as AnswerResponse } from './present.ts'
import { recordMastery, getSchedule, saveSchedule, nextSchedule, qualityFrom } from './mastery.ts'
import type { StoredQuestion } from './store.ts'
import type { Generated } from './schemas.ts'

/**
 * A timed mock exam.
 *
 * Built to the current published GRE structure, minus the essay:
 *
 *   Verbal 1   12 questions   18 minutes
 *   Verbal 2   15 questions   23 minutes
 *   Quant 1    12 questions   21 minutes
 *   Quant 2    15 questions   26 minutes
 *
 * The real test is **section-adaptive**: how you do on the first section of a measure
 * sets the difficulty of the second. That is reproduced here, which is why the second
 * section of each measure is only assembled once the first has been submitted.
 */

export type MockQuestion = PublicQuestion & { indexInSection: number }

export type MockSection = {
  index: number
  section: Section
  order: 1 | 2
  minutes: number
  questions: MockQuestion[]
  startedAt: string | null
  submittedAt: string | null
  correct: number | null
  /** Average difficulty of the questions served, 1-5. */
  level: number
}

export type MockExam = {
  id: string
  createdAt: string
  sections: MockSection[]
  current: number
  finished: boolean
}

const exams = new Map<string, MockExam>()

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
    format: r.format as StoredQuestion['format'],
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
 * Pull questions for one section, as close to the target difficulty as the pool
 * allows and spread across subtopics.
 *
 * Unseen questions are strongly preferred, but a mock that cannot be assembled is
 * worse than one containing a question you have met before, so seen questions are
 * used as a fallback rather than failing.
 */
export function drawSection(
  section: Section,
  count: number,
  targetDifficulty: number,
  exclude: string[],
): StoredQuestion[] {
  const notIn = exclude.length > 0 ? exclude.map(() => '?').join(',') : "''"

  const pick = (unseenOnly: boolean): Row[] =>
    db
      .prepare(
        `SELECT * FROM questions
         WHERE status = 'verified'
           AND section = ?
           AND id NOT IN (${notIn})
           ${unseenOnly ? 'AND first_served_at IS NULL' : ''}
         ORDER BY ABS(difficulty - ?) ASC, RANDOM()
         LIMIT ?`,
      )
      .all(section, ...exclude, targetDifficulty, count * 3) as Row[]

  let pool = pick(true)
  if (pool.length < count) {
    const seenToo = pick(false)
    const have = new Set(pool.map((r) => r.id))
    pool = [...pool, ...seenToo.filter((r) => !have.has(r.id))]
  }

  // Spread across subtopics: take one per subtopic first, then fill.
  const bySubtopic = new Map<string, Row[]>()
  for (const r of pool) {
    const list = bySubtopic.get(r.subtopic) ?? []
    list.push(r)
    bySubtopic.set(r.subtopic, list)
  }

  const chosen: Row[] = []
  let round = 0
  while (chosen.length < count) {
    let addedThisRound = false
    for (const list of bySubtopic.values()) {
      if (chosen.length >= count) break
      const item = list[round]
      if (item) {
        chosen.push(item)
        addedThisRound = true
      }
    }
    if (!addedThisRound) break
    round++
  }

  return chosen.map(hydrate)
}

function buildSection(
  index: number,
  blueprint: (typeof EXAM_SECTIONS)[number],
  targetDifficulty: number,
  used: string[],
): MockSection {
  const drawn = drawSection(blueprint.section, blueprint.questions, targetDifficulty, used)

  return {
    index,
    section: blueprint.section,
    order: blueprint.order as 1 | 2,
    minutes: blueprint.minutes,
    questions: drawn.map((q, i) => {
      const sub = requireSubtopic(q.subtopic)
      return { ...toPublic(q, 'drill', sub.label, sub.group), indexInSection: i }
    }),
    startedAt: null,
    submittedAt: null,
    correct: null,
    level:
      drawn.length > 0 ? drawn.reduce((n, q) => n + q.difficulty, 0) / drawn.length : targetDifficulty,
  }
}

/** How many verified questions exist, so the app can say whether a mock is possible. */
export function mockReadiness(): { quant: number; verbal: number; needQuant: number; needVerbal: number } {
  const count = (section: Section): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status = 'verified' AND section = ?").get(section) as {
      n: number
    }).n

  return {
    quant: count('quant'),
    verbal: count('verbal'),
    needQuant: EXAM_SECTIONS.filter((s) => s.section === 'quant').reduce((n, s) => n + s.questions, 0),
    needVerbal: EXAM_SECTIONS.filter((s) => s.section === 'verbal').reduce((n, s) => n + s.questions, 0),
  }
}

/**
 * Start a mock. Only the first section of each measure is built now; the second of
 * each is assembled after the first is submitted, so it can adapt.
 */
export function startMock(): MockExam {
  const id = randomUUID()
  const used: string[] = []

  const first = EXAM_SECTIONS.map((b, i) => ({ b, i })).filter(({ b }) => b.order === 1)
  const sections: MockSection[] = []

  for (const { b, i } of first) {
    const built = buildSection(i, b, 3, used)
    used.push(...built.questions.map((q) => q.id))
    sections.push(built)
  }

  // Placeholders for the adaptive second sections, filled in later.
  for (const [i, b] of EXAM_SECTIONS.entries()) {
    if (b.order !== 2) continue
    sections.push({
      index: i,
      section: b.section,
      order: 2,
      minutes: b.minutes,
      questions: [],
      startedAt: null,
      submittedAt: null,
      correct: null,
      level: 3,
    })
  }

  sections.sort((a, b) => a.index - b.index)

  const exam: MockExam = { id, createdAt: nowIso(), sections, current: 0, finished: false }
  exams.set(id, exam)
  return exam
}

export function getMock(id: string): MockExam | undefined {
  return exams.get(id)
}

/** The difficulty the next section of a measure should target. */
export function adaptiveTarget(correct: number, total: number): number {
  if (total === 0) return 3
  const share = correct / total
  if (share >= 0.85) return 5
  if (share >= 0.65) return 4
  if (share >= 0.45) return 3
  return 2
}

/**
 * Close off any section that came back empty because the question pool ran dry.
 *
 * Without this, an exhausted pool leaves a section with no questions and the
 * test-taker stranded on a blank screen with no way to continue. A second section
 * is only considered unfillable once its first section has been submitted -- before
 * that it is legitimately empty, because it has not been built yet.
 */
function closeUnfillableSections(exam: MockExam): void {
  for (const s of exam.sections) {
    if (s.submittedAt !== null || s.questions.length > 0) continue

    const firstOfMeasure = exam.sections.find((o) => o.section === s.section && o.order === 1)
    const measureStarted = s.order === 1 || firstOfMeasure?.submittedAt !== null
    if (!measureStarted) continue

    s.submittedAt = nowIso()
    s.correct = 0
  }
}

/** True when a section was skipped for want of questions rather than actually taken. */
export function wasSkipped(s: MockSection): boolean {
  return s.submittedAt !== null && s.questions.length === 0
}

export type SectionResult = {
  correct: number
  total: number
  perQuestion: Array<{
    questionId: string
    correct: boolean
    correctIndices?: number[]
    correctValue?: number
    explanation: string
    yourResponse: AnswerResponse | null
  }>
}

export function submitSection(
  exam: MockExam,
  sectionIndex: number,
  answers: Record<string, AnswerResponse | null>,
  secondsPerQuestion: Record<string, number>,
): SectionResult {
  const sec = exam.sections.find((s) => s.index === sectionIndex)
  if (!sec) throw new Error('no such section')

  const perQuestion: SectionResult['perQuestion'] = []
  let correct = 0

  for (const q of sec.questions) {
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id) as Row | undefined
    if (!row) continue
    const stored = hydrate(row)
    const response = answers[q.id] ?? null

    // An unanswered question is simply wrong, exactly as on the real test.
    const graded = response
      ? grade(stored.format, stored.payload, response)
      : { correct: false, explanation: stored.explanation }

    if (graded.correct) correct++

    const seconds = secondsPerQuestion[q.id] ?? 0
    db.prepare(
      'INSERT INTO attempts (question_id, mode, response, correct, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(q.id, 'mock', JSON.stringify(response), graded.correct ? 1 : 0, seconds, nowIso())

    recordMastery(stored.subtopic, graded.correct, stored.difficulty)

    const existing = getSchedule(q.id)
    if (!graded.correct || existing) {
      saveSchedule(q.id, nextSchedule(existing, qualityFrom(graded.correct, seconds, stored.difficulty)))
    }

    db.prepare('UPDATE questions SET first_served_at = COALESCE(first_served_at, ?) WHERE id = ?').run(
      nowIso(),
      q.id,
    )

    perQuestion.push({
      questionId: q.id,
      correct: graded.correct,
      correctIndices: (graded as { correctIndices?: number[] }).correctIndices,
      correctValue: (graded as { correctValue?: number }).correctValue,
      explanation: graded.explanation,
      yourResponse: response,
    })
  }

  sec.correct = correct
  sec.submittedAt = nowIso()

  // Build the matching second section now, adapted to how this one went.
  if (sec.order === 1) {
    const next = exam.sections.find((s) => s.section === sec.section && s.order === 2)
    if (next && next.questions.length === 0) {
      const blueprint = EXAM_SECTIONS[next.index]
      if (blueprint) {
        const used = exam.sections.flatMap((s) => s.questions.map((q) => q.id))
        const built = buildSection(next.index, blueprint, adaptiveTarget(correct, sec.questions.length), used)
        next.questions = built.questions
        next.level = built.level
      }
    }
  }

  closeUnfillableSections(exam)

  const remaining = exam.sections.filter((s) => s.submittedAt === null)
  if (remaining.length === 0) exam.finished = true
  else exam.current = Math.min(...remaining.map((s) => s.index))

  return { correct, total: sec.questions.length, perQuestion }
}

/**
 * A rough scaled score, 130-170 per measure.
 *
 * This is an approximation, not an official concordance. It uses the share correct
 * and nudges by the difficulty of the questions actually served, since answering
 * harder questions correctly is worth more on a section-adaptive test.
 */
export function estimateScore(exam: MockExam, section: Section): { score: number; correct: number; total: number } {
  // A section skipped for want of questions is excluded entirely rather than
  // counted as zero, which would misreport the score as a failure.
  const secs = exam.sections.filter((s) => s.section === section && s.correct !== null && !wasSkipped(s))
  const correct = secs.reduce((n, s) => n + (s.correct ?? 0), 0)
  const total = secs.reduce((n, s) => n + s.questions.length, 0)
  if (total === 0) return { score: 130, correct: 0, total: 0 }

  const share = correct / total
  const avgLevel = secs.reduce((n, s) => n + s.level, 0) / secs.length

  // 130 floor, 40 points of range, with up to 4 points of adjustment for facing
  // harder or easier material than a middling set.
  const base = 130 + share * 40
  const adjustment = (avgLevel - 3) * 2
  return {
    score: Math.max(130, Math.min(170, Math.round(base + adjustment))),
    correct,
    total,
  }
}
