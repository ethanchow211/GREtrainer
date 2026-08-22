import { QC_OPTIONS, type Format } from '../content/taxonomy.ts'
import type {
  Generated,
  GeneratedChoice,
  GeneratedComparison,
  GeneratedReading,
  GeneratedSentenceEquivalence,
  GeneratedTextCompletion,
} from './schemas.ts'
import type { StoredQuestion } from './store.ts'
import { evaluate, matchesAnswer } from './expr.ts'

/**
 * Turning a stored question into something safe to send to the browser, and marking
 * an answer once it comes back.
 *
 * The answer never leaves the server until you have committed to one. It would be
 * easy to ship the whole question object and hide the key in the interface, and it
 * would also mean the answer sits in the page source of every question you are
 * looking at. Grading happens here instead.
 */

export type PublicQuestion = {
  id: string
  section: string
  subtopic: string
  subtopicLabel: string
  group: string
  format: Format
  difficulty: number
  mode: 'drill' | 'review'
  /** Shared setup text; empty for formats that do not use one. */
  stem: string
  passage?: string
  /** For quantitative comparison. */
  quantityA?: string
  quantityB?: string
  /** Flat option list for single-list formats. */
  options?: string[]
  /** Per-blank option lists for text completion. */
  blanks?: Array<{ options: string[] }>
  /** How many options must be chosen, when that is fixed. */
  chooseExactly?: number
  /** True when the answer is typed rather than chosen. */
  numericEntry?: boolean
}

export type Response =
  | { kind: 'choice'; indices: number[] }
  | { kind: 'blanks'; indices: number[] }
  | { kind: 'numeric'; value: string }

export function toPublic(q: StoredQuestion, mode: 'drill' | 'review', label: string, group: string): PublicQuestion {
  const base = {
    id: q.id,
    section: q.section,
    subtopic: q.subtopic,
    subtopicLabel: label,
    group,
    format: q.format,
    difficulty: q.difficulty,
    mode,
  }

  switch (q.format) {
    case 'mc': {
      const d = q.payload as GeneratedChoice
      return { ...base, stem: d.stem, options: d.options, chooseExactly: 1 }
    }
    case 'ms': {
      const d = q.payload as GeneratedChoice
      return { ...base, stem: d.stem, options: d.options }
    }
    case 'ne': {
      return { ...base, stem: (q.payload as { stem: string }).stem, numericEntry: true }
    }
    case 'qc': {
      const d = q.payload as GeneratedComparison
      return {
        ...base,
        stem: d.stem,
        quantityA: d.quantityA,
        quantityB: d.quantityB,
        options: [...QC_OPTIONS],
        chooseExactly: 1,
      }
    }
    case 'tc': {
      const d = q.payload as GeneratedTextCompletion
      return { ...base, stem: d.stem, blanks: d.blanks.map((b) => ({ options: b.options })) }
    }
    case 'se': {
      const d = q.payload as GeneratedSentenceEquivalence
      return { ...base, stem: d.stem, options: d.options, chooseExactly: 2 }
    }
    case 'rc': {
      const d = q.payload as GeneratedReading
      return {
        ...base,
        stem: d.stem,
        passage: d.passage,
        options: d.options,
        chooseExactly: d.correctIndices.length === 1 ? 1 : undefined,
      }
    }
  }
}

export type Grade = {
  correct: boolean
  /** The correct answer, in a form the interface can highlight. */
  correctIndices?: number[]
  correctValue?: number
  explanation: string
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

/** Accept what a person would actually type: "3/4", "0.75", "1,200", " 12 ". */
export function parseTypedNumber(text: string): number {
  const cleaned = text.trim().replace(/,/g, '')
  if (cleaned === '') return Number.NaN
  const r = evaluate(cleaned)
  return r.ok ? r.value : Number.NaN
}

export function grade(format: Format, payload: Generated, response: Response): Grade {
  const explanation = (payload as { explanation: string }).explanation

  switch (format) {
    case 'mc':
    case 'ms':
    case 'rc':
    case 'se': {
      const d = payload as GeneratedChoice | GeneratedReading | GeneratedSentenceEquivalence
      const picked = response.kind === 'choice' ? response.indices : []
      return { correct: sameSet(picked, d.correctIndices), correctIndices: d.correctIndices, explanation }
    }

    case 'qc': {
      const d = payload as GeneratedComparison
      const index = { A: 0, B: 1, equal: 2, undetermined: 3 }[d.relation]
      const picked = response.kind === 'choice' ? response.indices : []
      return { correct: picked.length === 1 && picked[0] === index, correctIndices: [index], explanation }
    }

    case 'tc': {
      const d = payload as GeneratedTextCompletion
      const picked = response.kind === 'blanks' ? response.indices : []
      const expected = d.blanks.map((b) => b.correctIndex)
      // Order matters here: index i is blank i, so this is not a set comparison.
      const correct = picked.length === expected.length && expected.every((v, i) => picked[i] === v)
      return { correct, correctIndices: expected, explanation }
    }

    case 'ne': {
      const d = payload as { correctValue: number; explanation: string }
      const typed = response.kind === 'numeric' ? parseTypedNumber(response.value) : Number.NaN
      return {
        correct: Number.isFinite(typed) && matchesAnswer(typed, d.correctValue),
        correctValue: d.correctValue,
        explanation: d.explanation,
      }
    }
  }
}
