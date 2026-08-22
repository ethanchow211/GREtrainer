import { callClaude, type Usage } from './claude.ts'
import { recordCall, budget } from './db.ts'
import { config } from './config.ts'
import { schemaForFormat, type Generated } from './schemas.ts'
import { requireSubtopic, type Difficulty, type Format, type Subtopic } from '../content/taxonomy.ts'

/**
 * Writing questions.
 *
 * The system prompt below is the single highest-leverage piece of text in this
 * project: it is what makes generated questions read like the real test rather than
 * like a textbook exercise. It is deliberately specific about *how GRE questions are
 * built* -- especially that wrong options must each correspond to a particular
 * mistake a real test-taker would make.
 */

const SHARED_RULES = `
You write practice questions for the GRE General Test.

Absolute rules:
- Never reproduce a real ETS question. Everything you write must be original.
- Exactly one answer must be defensible. If a question could reasonably be argued
  two ways, it is a broken question -- rewrite it rather than shipping it.
- Every wrong option must be the result of a specific, plausible mistake: a sign
  error, using the wrong formula, answering the question that was not asked,
  stopping one step early, or a word that fits the sentence's grammar but not its
  logic. Never write filler options that nobody would pick.
- Match real GRE difficulty and phrasing. These are compact, precisely worded
  questions, not textbook drills or word-problem whimsy.
- The explanation teaches the method, not just the arithmetic. State the insight
  that makes the question quick, and name the trap the wrong options are baiting.

Formatting:
- Write mathematics in LaTeX between single dollar signs, like $x^2 + 3x - 4 = 0$
  or $\\frac{3}{4}$. Do not use unicode maths symbols.
- Keep the question stem free of any hint about which option is correct.
- Do not label options with letters; supply them as a plain list in order.
- When the explanation refers to an option, name it by the LETTER it will be shown
  with -- the first option is A, the second B, and so on. Never call it "option 1"
  or "the third choice": the reader sees letters, and a mismatch is confusing.
`.trim()

const DIFFICULTY_GUIDE: Record<Difficulty, string> = {
  1: 'Easy. One step, familiar setup. A well-prepared test-taker answers it in under 45 seconds.',
  2: 'Lower-medium. Two steps, or one step with a small twist in the wording.',
  3: 'Medium. Two or three steps, and at least one option baits a common error.',
  4: 'Hard. Requires either a non-obvious insight or careful multi-step work under time pressure.',
  5: 'Very hard, top of the scoring range. Rewards recognising structure; brute force should be too slow to finish in time.',
}

function formatRules(format: Format): string {
  switch (format) {
    case 'mc':
      return `
Format: multiple choice with exactly one correct answer. Supply 5 options.
"correctIndices" holds exactly one index.
Set "correctValue" to the correct answer as a plain number when the answer is a
number, otherwise null. Set "checkExpr" to an arithmetic expression that evaluates
to "correctValue" using only digits, + - * / ^ ( ) and the functions sqrt, abs, min,
max, floor, ceil, round, pow. It must contain no variables. If the answer is not a
number, set both to null.`.trim()

    case 'ms':
      return `
Format: "select all that apply" with one or more correct answers. Supply 3 to 8
options. "correctIndices" holds every correct index. At least one option must be
wrong, and it must be genuinely tempting.
Set "correctValue" and "checkExpr" to null for this format.`.trim()

    case 'ne':
      return `
Format: numeric entry. There are no options -- the test-taker types the number.
"correctValue" is that number. "checkExpr" is arithmetic evaluating to it, using only
digits, + - * / ^ ( ) and sqrt, abs, min, max, floor, ceil, round, pow, with no
variables. Set "answerIsFraction" true only if the answer is naturally a fraction.
Prefer answers that are exact rather than long decimals.`.trim()

    case 'qc':
      return `
Format: Quantitative Comparison. The four answer choices are always the same and are
not generated. You supply the two quantities being compared.

"stem" holds any shared setup (it may be an empty string if there is none).
"quantityA" and "quantityB" hold the two expressions.
"relation" is "A" if Quantity A is always greater, "B" if Quantity B is always
greater, "equal" if they are always equal, and "undetermined" if the relationship
depends on values the question does not pin down.

When a quantity is a fixed number, set checkA / checkB to arithmetic that evaluates
to it (digits, + - * / ^ ( ), sqrt, abs, min, max, floor, ceil, round, pow, no
variables). When a quantity is not a fixed number, set that one to null.

"undetermined" is a real and common answer -- roughly a quarter of comparisons. Do
not avoid it, but only use it when two specific cases genuinely give different
relationships, and name both cases in the explanation.`.trim()

    case 'tc':
      return `
Format: Text Completion. Write one to three sentences of dense academic prose with
blanks marked exactly as (i), (ii), (iii) in order of appearance.

For a single-blank question supply 5 options for that blank. For two or three blanks
supply exactly 3 options each.

The sentence must contain a definite clue -- a contrast word, a restatement, a
causal link -- that forces the answer. A test-taker who knows every word must still
be able to reason to exactly one choice. Wrong options should be real words that fit
the grammar but contradict the sentence's logic.`.trim()

    case 'se':
      return `
Format: Sentence Equivalence. One sentence, one blank marked as ______, six options,
and exactly two correct answers.

The two correct words must both fit the sentence AND produce sentences that mean
substantially the same thing. Include at least one pair of near-synonyms among the
wrong options that does NOT fit the sentence -- that trap is the whole point of the
format. Never include a word whose only near-synonym is absent from the list.`.trim()

    case 'rc':
      return `
Format: Reading Comprehension. Write an original passage of 90 to 200 words in the
register of an academic journal or serious non-fiction -- humanities, social science,
or natural science. It must contain a real argument or tension, not just facts.

Then write one question about it with 3 to 5 options.

The correct answer must be forced by the passage, not merely consistent with it.
Wrong options should be the classic traps: true but not what was asked, too extreme,
outside the passage's scope, or a distortion of something the passage actually says.`.trim()
  }
}

function systemPromptFor(format: Format): string {
  return `${SHARED_RULES}\n\n${formatRules(format)}\n\nReply with JSON matching the schema. No commentary.`
}

export type GenerateRequest = {
  subtopicId: string
  format: Format
  difficulty: Difficulty
  /** Stems of recent questions in this bucket, so the generator does not repeat itself. */
  avoid?: string[]
}

export type GenerateOk = { ok: true; data: Generated; subtopic: Subtopic; usage: Usage }
export type GenerateErr = { ok: false; error: string }
export type GenerateResult = GenerateOk | GenerateErr

export async function generateQuestion(req: GenerateRequest): Promise<GenerateResult> {
  const state = budget()
  if (state.exhausted) {
    return {
      ok: false,
      error: `daily Claude call limit reached (${state.used}/${state.limit}). Raise GRE_MAX_CALLS_PER_DAY in .env or come back tomorrow.`,
    }
  }

  const subtopic = requireSubtopic(req.subtopicId)
  if (!subtopic.formats.includes(req.format)) {
    return { ok: false, error: `${subtopic.label} does not use the ${req.format} format` }
  }

  const avoidBlock =
    req.avoid && req.avoid.length > 0
      ? `\n\nYou have recently written the questions below. Write something materially different -- a different setup, different numbers, a different angle on the topic. Do not merely reword these.\n${req.avoid
          .map((s, i) => `${i + 1}. ${s.slice(0, 180)}`)
          .join('\n')}`
      : ''

  const prompt = `Write one GRE ${subtopic.section === 'quant' ? 'Quantitative' : 'Verbal'} Reasoning question.

Topic: ${subtopic.group} -- ${subtopic.label}
What this topic covers: ${subtopic.note}
Target difficulty: ${req.difficulty} of 5. ${DIFFICULTY_GUIDE[req.difficulty]}

Set the "difficulty" field to your honest assessment of what you actually wrote, which may differ from the target.${avoidBlock}`

  const res = await callClaude<Generated>({
    system: systemPromptFor(req.format),
    prompt,
    schema: schemaForFormat(req.format),
  })

  recordCall({
    purpose: 'generate',
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
  return { ok: true, data: res.data, subtopic, usage: res.usage }
}
