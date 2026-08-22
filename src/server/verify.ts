import { callClaude } from './claude.ts'
import { recordCall, budget } from './db.ts'
import { config } from './config.ts'
import { evaluate, matchesAnswer } from './expr.ts'
import { VERIFIER_SCHEMA, type VerifierReply } from './schemas.ts'
import type {
  Generated,
  GeneratedChoice,
  GeneratedComparison,
  GeneratedNumeric,
  GeneratedReading,
  GeneratedSentenceEquivalence,
  GeneratedTextCompletion,
} from './schemas.ts'
import { QC_OPTIONS, type Format } from '../content/taxonomy.ts'

/**
 * Deciding whether a generated question is fit to serve.
 *
 * Three gates, cheapest first:
 *
 *   1. Structure  -- pure logic, free. Option counts, index ranges, duplicates.
 *   2. Arithmetic -- our own evaluator recomputes the maths. Free, quant only.
 *   3. Second opinion -- a fresh Claude call solves the question cold, never having
 *      seen the proposed answer. Costs one call, so it runs last.
 *
 * A question must pass all applicable gates. Failures are kept in the database
 * rather than deleted, so the rejection rate is visible instead of invisible.
 */

const LETTERS = 'ABCDEFGH'

export type Verdict = {
  status: 'verified' | 'rejected'
  reason?: string
  note?: string
  /** True if a Claude call was spent. */
  calledClaude: boolean
}

// ------------------------------------------------------------------ gate 1: structure

function distinct(values: string[]): boolean {
  const seen = new Set(values.map((v) => v.trim().toLowerCase()))
  return seen.size === values.length
}

function structuralProblems(format: Format, q: Generated): string[] {
  const problems: string[] = []

  const explanation = (q as { explanation?: string }).explanation ?? ''
  if (explanation.trim().length < 40) {
    problems.push('explanation is too short to teach anything')
  }

  // Observed in practice: the generator occasionally returns a schema-shaped
  // skeleton full of placeholder text instead of a real question. It satisfies every
  // structural rule, so it has to be caught by name.
  const textFields = [
    (q as { stem?: string }).stem,
    (q as { passage?: string }).passage,
    explanation,
  ].filter((v): v is string => typeof v === 'string')

  const PLACEHOLDER = /^(test|sample|example|placeholder|lorem ipsum|todo|tbd)\b/i
  if (textFields.some((t) => PLACEHOLDER.test(t.trim()))) {
    problems.push('contains placeholder text rather than a real question')
  }

  switch (format) {
    case 'mc': {
      const d = q as GeneratedChoice
      if (d.options.length !== 5) problems.push(`multiple choice needs 5 options, got ${d.options.length}`)
      if (d.correctIndices.length !== 1) {
        problems.push(`multiple choice needs exactly 1 correct answer, got ${d.correctIndices.length}`)
      }
      if (d.correctIndices.some((i) => i < 0 || i >= d.options.length)) {
        problems.push('correct answer index is outside the option list')
      }
      if (!distinct(d.options)) problems.push('two options are the same')
      break
    }

    case 'ms': {
      const d = q as GeneratedChoice
      if (d.options.length < 3) problems.push('select-all needs at least 3 options')
      if (d.correctIndices.length < 1) problems.push('select-all needs at least 1 correct answer')
      if (d.correctIndices.length >= d.options.length) problems.push('every option is marked correct')
      if (d.correctIndices.some((i) => i < 0 || i >= d.options.length)) {
        problems.push('a correct answer index is outside the option list')
      }
      if (new Set(d.correctIndices).size !== d.correctIndices.length) {
        problems.push('the same option is listed as correct twice')
      }
      if (!distinct(d.options)) problems.push('two options are the same')
      break
    }

    case 'ne': {
      const d = q as GeneratedNumeric
      if (!Number.isFinite(d.correctValue)) problems.push('numeric answer is not a finite number')
      if (!d.checkExpr || d.checkExpr.trim() === '') problems.push('no arithmetic supplied to check the answer')
      break
    }

    case 'qc': {
      const d = q as GeneratedComparison
      if (!['A', 'B', 'equal', 'undetermined'].includes(d.relation)) {
        problems.push(`unknown relation "${d.relation}"`)
      }
      if (d.quantityA.trim() === d.quantityB.trim() && d.relation !== 'equal') {
        problems.push('the two quantities are written identically but the answer is not "equal"')
      }
      break
    }

    case 'tc': {
      const d = q as GeneratedTextCompletion
      const n = d.blanks.length
      if (n < 1 || n > 3) problems.push(`text completion needs 1-3 blanks, got ${n}`)
      const expectedOptions = n === 1 ? 5 : 3
      d.blanks.forEach((b, i) => {
        if (b.options.length !== expectedOptions) {
          problems.push(`blank ${i + 1} needs ${expectedOptions} options, got ${b.options.length}`)
        }
        if (b.correctIndex < 0 || b.correctIndex >= b.options.length) {
          problems.push(`blank ${i + 1} correct index is outside its option list`)
        }
        if (!distinct(b.options)) problems.push(`blank ${i + 1} repeats an option`)
      })
      if (n > 1) {
        for (let i = 1; i <= n; i++) {
          const marker = `(${'i'.repeat(i)})`
          if (!d.stem.includes(marker)) problems.push(`stem is missing the ${marker} blank marker`)
        }
      }
      break
    }

    case 'se': {
      const d = q as GeneratedSentenceEquivalence
      if (d.options.length !== 6) problems.push(`sentence equivalence needs 6 options, got ${d.options.length}`)
      if (d.correctIndices.length !== 2) {
        problems.push(`sentence equivalence needs exactly 2 correct answers, got ${d.correctIndices.length}`)
      }
      if (new Set(d.correctIndices).size !== d.correctIndices.length) {
        problems.push('the same option is listed as correct twice')
      }
      if (d.correctIndices.some((i) => i < 0 || i >= d.options.length)) {
        problems.push('a correct answer index is outside the option list')
      }
      if (!distinct(d.options)) problems.push('two options are the same')
      if (!d.stem.includes('___')) problems.push('the sentence has no blank in it')
      break
    }

    case 'rc': {
      const d = q as GeneratedReading
      const words = d.passage.trim().split(/\s+/).length
      if (words < 60) problems.push(`passage is only ${words} words, too short to support a real question`)
      if (words > 400) problems.push(`passage is ${words} words, longer than the GRE uses`)
      if (d.options.length < 3) problems.push('needs at least 3 options')
      if (d.correctIndices.some((i) => i < 0 || i >= d.options.length)) {
        problems.push('a correct answer index is outside the option list')
      }
      if (!distinct(d.options)) problems.push('two options are the same')
      break
    }
  }

  return problems
}

// ----------------------------------------------------------------- gate 2: arithmetic

function arithmeticProblems(format: Format, q: Generated): string[] {
  const problems: string[] = []

  if (format === 'ne') {
    const d = q as GeneratedNumeric
    const r = evaluate(d.checkExpr)
    if (!r.ok) {
      problems.push(`its own arithmetic "${d.checkExpr}" does not evaluate: ${r.error}`)
    } else if (!matchesAnswer(r.value, d.correctValue)) {
      problems.push(`its own arithmetic gives ${r.value} but the stated answer is ${d.correctValue}`)
    }
    return problems
  }

  if (format === 'mc') {
    const d = q as GeneratedChoice
    if (d.checkExpr && d.correctValue !== null) {
      const r = evaluate(d.checkExpr)
      if (!r.ok) {
        problems.push(`its own arithmetic "${d.checkExpr}" does not evaluate: ${r.error}`)
      } else if (!matchesAnswer(r.value, d.correctValue)) {
        problems.push(`its own arithmetic gives ${r.value} but the stated answer is ${d.correctValue}`)
      } else {
        // The computed value must also match the option it points at.
        const chosen = d.options[d.correctIndices[0] as number]
        const asNumber = chosen === undefined ? Number.NaN : parseLooseNumber(chosen)
        if (Number.isFinite(asNumber) && !matchesAnswer(r.value, asNumber)) {
          problems.push(`the arithmetic gives ${r.value} but the option marked correct reads "${chosen}"`)
        }
      }
    }
    return problems
  }

  if (format === 'qc') {
    const d = q as GeneratedComparison
    const a = d.checkA ? evaluate(d.checkA) : null
    const b = d.checkB ? evaluate(d.checkB) : null

    if (d.checkA && a && !a.ok) problems.push(`Quantity A arithmetic "${d.checkA}" does not evaluate: ${a.error}`)
    if (d.checkB && b && !b.ok) problems.push(`Quantity B arithmetic "${d.checkB}" does not evaluate: ${b.error}`)

    if (a?.ok && b?.ok) {
      const computed = matchesAnswer(a.value, b.value) ? 'equal' : a.value > b.value ? 'A' : 'B'
      if (d.relation === 'undetermined') {
        problems.push(
          `both quantities evaluate to fixed numbers (${a.value} and ${b.value}), so the answer cannot be "undetermined"`,
        )
      } else if (computed !== d.relation) {
        problems.push(
          `computing both quantities gives ${a.value} vs ${b.value} (answer "${computed}") but the question claims "${d.relation}"`,
        )
      }
    }
    return problems
  }

  return problems
}

/** Pull a number out of an option string like "$12$", "12.5", or "-3/4". */
function parseLooseNumber(text: string): number {
  const cleaned = text.replace(/\$/g, '').replace(/\\frac\{(-?\d+(?:\.\d+)?)\}\{(-?\d+(?:\.\d+)?)\}/g, '($1)/($2)').trim()
  const r = evaluate(cleaned)
  return r.ok ? r.value : Number.NaN
}

// ------------------------------------------------------------ gate 3: second opinion

/** Render the question as plain text, with the answer stripped out. */
function renderForSolver(format: Format, q: Generated): { text: string; answerInstruction: string } {
  switch (format) {
    case 'mc':
    case 'ms': {
      const d = q as GeneratedChoice
      const opts = d.options.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n')
      return {
        text: `${d.stem}\n\n${opts}`,
        answerInstruction:
          format === 'mc'
            ? 'Reply with the single correct letter, e.g. "C".'
            : 'Reply with every correct letter separated by commas in alphabetical order, e.g. "A,C".',
      }
    }

    case 'ne': {
      const d = q as GeneratedNumeric
      return {
        text: d.stem,
        answerInstruction: 'Reply with the number only, e.g. "42" or "0.75". No units, no words.',
      }
    }

    case 'qc': {
      const d = q as GeneratedComparison
      const setup = d.stem.trim() ? `${d.stem.trim()}\n\n` : ''
      const opts = QC_OPTIONS.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n')
      return {
        text: `${setup}Quantity A: ${d.quantityA}\nQuantity B: ${d.quantityB}\n\n${opts}`,
        answerInstruction:
          'Reply with exactly one of: "A" (Quantity A greater), "B" (Quantity B greater), "equal", or "undetermined".',
      }
    }

    case 'tc': {
      const d = q as GeneratedTextCompletion
      const blocks = d.blanks
        .map((b, i) => `Blank ${i + 1} options:\n${b.options.map((o, j) => `${LETTERS[j]}. ${o}`).join('\n')}`)
        .join('\n\n')
      return {
        text: `${d.stem}\n\n${blocks}`,
        answerInstruction:
          d.blanks.length === 1
            ? 'Reply with the single correct letter, e.g. "C".'
            : `Reply with one letter per blank in order, separated by semicolons, e.g. "${d.blanks.map(() => 'B').join(';')}".`,
      }
    }

    case 'se': {
      const d = q as GeneratedSentenceEquivalence
      const opts = d.options.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n')
      return {
        text: `${d.stem}\n\n${opts}`,
        answerInstruction:
          'Reply with exactly two letters separated by a comma in alphabetical order, e.g. "B,E". The two words must both fit AND give the sentence the same meaning.',
      }
    }

    case 'rc': {
      const d = q as GeneratedReading
      const opts = d.options.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n')
      return {
        text: `Passage:\n${d.passage}\n\nQuestion: ${d.stem}\n\n${opts}`,
        answerInstruction:
          d.correctIndices.length > 1
            ? 'Reply with every correct letter separated by commas in alphabetical order, e.g. "A,C".'
            : 'Reply with the single correct letter, e.g. "C".',
      }
    }
  }
}

/** The proposed answer, in the same encoding we ask the solver for. */
function canonicalAnswer(format: Format, q: Generated): string {
  switch (format) {
    case 'mc':
    case 'ms':
    case 'rc': {
      const d = q as GeneratedChoice | GeneratedReading
      return [...d.correctIndices].sort((a, b) => a - b).map((i) => LETTERS[i]).join(',')
    }
    case 'se': {
      const d = q as GeneratedSentenceEquivalence
      return [...d.correctIndices].sort((a, b) => a - b).map((i) => LETTERS[i]).join(',')
    }
    case 'ne':
      return String((q as GeneratedNumeric).correctValue)
    case 'qc':
      return (q as GeneratedComparison).relation
    case 'tc':
      return (q as GeneratedTextCompletion).blanks.map((b) => LETTERS[b.correctIndex]).join(';')
  }
}

function answersAgree(format: Format, proposed: string, solved: string): boolean {
  const norm = (s: string) => s.trim().replace(/["'.]/g, '').toUpperCase()

  if (format === 'ne') {
    const a = Number(proposed)
    const b = parseLooseNumber(solved)
    return matchesAnswer(a, b)
  }

  if (format === 'qc') {
    const map = (s: string): string => {
      const v = norm(s)
      if (v === 'A' || v.startsWith('QUANTITY A')) return 'A'
      if (v === 'B' || v.startsWith('QUANTITY B')) return 'B'
      if (v.startsWith('EQUAL')) return 'equal'
      if (v.startsWith('UNDETERMINED') || v.startsWith('CANNOT')) return 'undetermined'
      if (v === 'C') return 'equal' // solver used the letter of the fixed option list
      if (v === 'D') return 'undetermined'
      return v
    }
    return map(proposed) === map(solved)
  }

  const split = (s: string) =>
    norm(s)
      .split(/[,;\s]+/)
      .filter(Boolean)
      .sort()
      .join(format === 'tc' ? ';' : ',')

  return split(proposed) === split(solved)
}

async function secondOpinion(
  format: Format,
  q: Generated,
): Promise<{ ok: true; reply: VerifierReply } | { ok: false; error: string }> {
  const { text, answerInstruction } = renderForSolver(format, q)

  const system = `You are an expert GRE tutor checking a practice question written by someone else.

You are given a question WITHOUT its answer key. Do two things:

1. Solve it yourself, carefully and from scratch. ${answerInstruction}
2. Judge whether the question is well formed. Set "wellFormed" to false if any of
   these is true, and say which in "problem":
   - more than one option is defensible, or none is
   - the question is ambiguous, or depends on information it does not give
   - an option is a duplicate in meaning of another
   - the maths is wrong or impossible
   - for Sentence Equivalence: the two intended words do not actually produce
     sentences with the same meaning, or a third word fits equally well

Be exacting. It is far better to flag a borderline question than to pass a broken one.
Judge the question on its own terms; do not assume the writer was correct.`

  const res = await callClaude<VerifierReply>({
    system,
    prompt: text,
    schema: VERIFIER_SCHEMA as unknown as Record<string, unknown>,
  })

  recordCall({
    purpose: 'verify',
    model: config.model,
    ok: res.ok,
    inputTokens: res.usage?.inputTokens,
    outputTokens: res.usage?.outputTokens,
    cacheTokens: (res.usage?.cacheCreationTokens ?? 0) + (res.usage?.cacheReadTokens ?? 0),
    costUsd: res.usage?.notionalCostUsd,
    durationMs: res.usage?.durationMs,
    error: res.ok ? undefined : res.error,
  })

  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, reply: res.data }
}

/** Run every applicable gate. Cheap ones first, so a broken question costs nothing. */
export async function verifyQuestion(format: Format, q: Generated): Promise<Verdict> {
  const structural = structuralProblems(format, q)
  if (structural.length > 0) {
    return { status: 'rejected', reason: `structure: ${structural.join('; ')}`, calledClaude: false }
  }

  const arithmetic = arithmeticProblems(format, q)
  if (arithmetic.length > 0) {
    return { status: 'rejected', reason: `arithmetic: ${arithmetic.join('; ')}`, calledClaude: false }
  }

  if (budget().exhausted) {
    return {
      status: 'rejected',
      reason: 'daily Claude call limit reached before this question could be independently checked',
      calledClaude: false,
    }
  }

  const opinion = await secondOpinion(format, q)
  if (!opinion.ok) {
    return { status: 'rejected', reason: `second opinion failed: ${opinion.error}`, calledClaude: true }
  }

  const proposed = canonicalAnswer(format, q)
  const solved = opinion.reply.answer

  if (!opinion.reply.wellFormed) {
    return {
      status: 'rejected',
      reason: `second opinion says not well formed: ${opinion.reply.problem ?? 'no reason given'}`,
      calledClaude: true,
    }
  }

  if (!answersAgree(format, proposed, solved)) {
    return {
      status: 'rejected',
      reason: `answers disagree: question says "${proposed}", independent solve says "${solved}"`,
      note: opinion.reply.reasoning.slice(0, 600),
      calledClaude: true,
    }
  }

  return { status: 'verified', note: opinion.reply.reasoning.slice(0, 600), calledClaude: true }
}

export const _internals = { structuralProblems, arithmeticProblems, canonicalAnswer, answersAgree, parseLooseNumber }
