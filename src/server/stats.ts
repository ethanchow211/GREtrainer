import { db } from './db.ts'
import { requireSubtopic, SUBTOPIC_BY_ID } from '../content/taxonomy.ts'
import { ERROR_TAG_BY_ID } from '../content/errors.ts'

/**
 * What the attempt history actually says about you.
 *
 * The headline number here is deliberately not accuracy. Accuracy tells you how you
 * are doing; the error breakdown tells you what to *do*. "41% of your quant misses
 * are arithmetic slips, not concept gaps" changes this week's practice. "You are 62%
 * on quant" does not.
 */

export type ErrorBreakdown = {
  tag: string
  label: string
  count: number
  share: number
  strategies: string[]
}

export type SectionStats = {
  section: 'quant' | 'verbal'
  attempts: number
  correct: number
  accuracy: number
  medianSeconds: number
  errors: ErrorBreakdown[]
}

export type WeakSpot = {
  subtopic: string
  label: string
  group: string
  section: string
  attempts: number
  correct: number
  accuracy: number
}

export type Stats = {
  totalAttempts: number
  sections: SectionStats[]
  weakest: WeakSpot[]
  /** Accuracy over recent sessions, oldest first, for a trend line. */
  recent: Array<{ day: string; attempts: number; accuracy: number }>
  pacing: { section: string; medianSeconds: number; parSeconds: number }[]
}

type AttemptRow = {
  section: string
  subtopic: string
  correct: number
  seconds: number
  error_tag: string | null
  created_at: string
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number)
}

/** The rough per-question budget the real test gives you, by section. */
const PAR_SECONDS: Record<string, number> = { quant: 105, verbal: 90 }

export function computeStats(): Stats {
  const rows = db
    .prepare(
      `SELECT q.section, q.subtopic, a.correct, a.seconds, a.error_tag, a.created_at
       FROM attempts a JOIN questions q ON q.id = a.question_id
       ORDER BY a.created_at ASC`,
    )
    .all() as AttemptRow[]

  const sections: SectionStats[] = (['quant', 'verbal'] as const).map((section) => {
    const mine = rows.filter((r) => r.section === section)
    const misses = mine.filter((r) => r.correct === 0)

    const counts = new Map<string, number>()
    for (const m of misses) {
      // An untagged miss is still a miss; it just cannot be attributed yet.
      const tag = m.error_tag ?? 'untagged'
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }

    const errors: ErrorBreakdown[] = [...counts.entries()]
      .map(([tag, count]) => {
        const meta = ERROR_TAG_BY_ID.get(tag)
        return {
          tag,
          label: meta?.label ?? 'Not yet tagged',
          count,
          share: misses.length > 0 ? count / misses.length : 0,
          strategies: meta?.strategies ?? [],
        }
      })
      .sort((a, b) => b.count - a.count)

    const correct = mine.filter((r) => r.correct === 1).length
    return {
      section,
      attempts: mine.length,
      correct,
      accuracy: mine.length > 0 ? correct / mine.length : 0,
      medianSeconds: Math.round(median(mine.map((r) => r.seconds))),
      errors,
    }
  })

  // Weakest subtopics by observed accuracy, but only where there is enough to say.
  const bySubtopic = new Map<string, { attempts: number; correct: number }>()
  for (const r of rows) {
    const e = bySubtopic.get(r.subtopic) ?? { attempts: 0, correct: 0 }
    e.attempts++
    e.correct += r.correct
    bySubtopic.set(r.subtopic, e)
  }

  const weakest: WeakSpot[] = [...bySubtopic.entries()]
    .filter(([id, e]) => e.attempts >= 3 && SUBTOPIC_BY_ID.has(id))
    .map(([id, e]) => {
      const sub = requireSubtopic(id)
      return {
        subtopic: id,
        label: sub.label,
        group: sub.group,
        section: sub.section,
        attempts: e.attempts,
        correct: e.correct,
        accuracy: e.correct / e.attempts,
      }
    })
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 8)

  // Group by local calendar day for the trend.
  const byDay = new Map<string, { attempts: number; correct: number }>()
  for (const r of rows) {
    const day = new Date(r.created_at).toLocaleDateString('en-CA') // YYYY-MM-DD
    const e = byDay.get(day) ?? { attempts: 0, correct: 0 }
    e.attempts++
    e.correct += r.correct
    byDay.set(day, e)
  }

  const recent = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-14)
    .map(([day, e]) => ({ day, attempts: e.attempts, accuracy: e.correct / e.attempts }))

  return {
    totalAttempts: rows.length,
    sections,
    weakest,
    recent,
    pacing: sections.map((s) => ({
      section: s.section,
      medianSeconds: s.medianSeconds,
      parSeconds: PAR_SECONDS[s.section] ?? 90,
    })),
  }
}
