import type { Format } from '../content/taxonomy.ts'

/**
 * The exact shape each kind of question must come back in.
 *
 * These are JSON Schemas rather than prose instructions because the `claude` CLI
 * enforces them at generation time -- array lengths, enum values and number ranges
 * are guaranteed before we ever look at the reply. That removes most malformed
 * output as a category, leaving us to check only the thing a schema cannot check:
 * whether the question is actually correct.
 */

const difficulty = { type: 'integer', minimum: 1, maximum: 5 } as const
const nonEmpty = { type: 'string', minLength: 1 } as const

/** Multiple choice (one answer), multiple select, and numeric entry, for quant. */
export const QUANT_CHOICE_SCHEMA = {
  type: 'object',
  properties: {
    stem: { ...nonEmpty },
    options: { type: 'array', items: nonEmpty, minItems: 3, maxItems: 8 },
    correctIndices: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 8 },
    /** The correct answer as a plain number when it is one, else null. */
    correctValue: { type: ['number', 'null'] },
    /** Arithmetic that evaluates to correctValue. We recompute it independently. */
    checkExpr: { type: ['string', 'null'] },
    explanation: { ...nonEmpty },
    difficulty,
  },
  required: ['stem', 'options', 'correctIndices', 'correctValue', 'checkExpr', 'explanation', 'difficulty'],
  additionalProperties: false,
} as const

export const QUANT_NUMERIC_SCHEMA = {
  type: 'object',
  properties: {
    stem: { ...nonEmpty },
    correctValue: { type: 'number' },
    /** Set when the answer is a fraction the test would accept as such. */
    answerIsFraction: { type: 'boolean' },
    checkExpr: { ...nonEmpty },
    explanation: { ...nonEmpty },
    difficulty,
  },
  required: ['stem', 'correctValue', 'answerIsFraction', 'checkExpr', 'explanation', 'difficulty'],
  additionalProperties: false,
} as const

/**
 * Quantitative Comparison. The four options never vary, so they are not generated.
 * When both quantities are determinate the model must supply arithmetic for each,
 * which lets us verify the claimed relation by computing it ourselves.
 */
export const QUANT_COMPARISON_SCHEMA = {
  type: 'object',
  properties: {
    stem: { type: 'string' },
    quantityA: { ...nonEmpty },
    quantityB: { ...nonEmpty },
    relation: { type: 'string', enum: ['A', 'B', 'equal', 'undetermined'] },
    /** Arithmetic for each quantity, or null when the quantity is not a fixed number. */
    checkA: { type: ['string', 'null'] },
    checkB: { type: ['string', 'null'] },
    explanation: { ...nonEmpty },
    difficulty,
  },
  required: ['stem', 'quantityA', 'quantityB', 'relation', 'checkA', 'checkB', 'explanation', 'difficulty'],
  additionalProperties: false,
} as const

/** Text Completion: one to three blanks, each with its own option set. */
export const TEXT_COMPLETION_SCHEMA = {
  type: 'object',
  properties: {
    stem: { ...nonEmpty },
    blanks: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          options: { type: 'array', items: nonEmpty, minItems: 3, maxItems: 5 },
          correctIndex: { type: 'integer', minimum: 0, maximum: 4 },
        },
        required: ['options', 'correctIndex'],
        additionalProperties: false,
      },
    },
    explanation: { ...nonEmpty },
    difficulty,
  },
  required: ['stem', 'blanks', 'explanation', 'difficulty'],
  additionalProperties: false,
} as const

/** Sentence Equivalence: six options, exactly two correct. */
export const SENTENCE_EQUIVALENCE_SCHEMA = {
  type: 'object',
  properties: {
    stem: { ...nonEmpty },
    options: { type: 'array', items: nonEmpty, minItems: 6, maxItems: 6 },
    correctIndices: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 5 }, minItems: 2, maxItems: 2 },
    explanation: { ...nonEmpty },
    difficulty,
  },
  required: ['stem', 'options', 'correctIndices', 'explanation', 'difficulty'],
  additionalProperties: false,
} as const

/** Reading Comprehension: a passage plus one question about it. */
export const READING_COMP_SCHEMA = {
  type: 'object',
  properties: {
    passage: { ...nonEmpty },
    stem: { ...nonEmpty },
    options: { type: 'array', items: nonEmpty, minItems: 3, maxItems: 5 },
    correctIndices: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 4 }, minItems: 1, maxItems: 3 },
    explanation: { ...nonEmpty },
    difficulty,
  },
  required: ['passage', 'stem', 'options', 'correctIndices', 'explanation', 'difficulty'],
  additionalProperties: false,
} as const

export function schemaForFormat(format: Format): Record<string, unknown> {
  switch (format) {
    case 'mc':
    case 'ms':
      return QUANT_CHOICE_SCHEMA as unknown as Record<string, unknown>
    case 'ne':
      return QUANT_NUMERIC_SCHEMA as unknown as Record<string, unknown>
    case 'qc':
      return QUANT_COMPARISON_SCHEMA as unknown as Record<string, unknown>
    case 'tc':
      return TEXT_COMPLETION_SCHEMA as unknown as Record<string, unknown>
    case 'se':
      return SENTENCE_EQUIVALENCE_SCHEMA as unknown as Record<string, unknown>
    case 'rc':
      return READING_COMP_SCHEMA as unknown as Record<string, unknown>
  }
}

// ---------------------------------------------------------------- generated shapes

export type GeneratedChoice = {
  stem: string
  options: string[]
  correctIndices: number[]
  correctValue: number | null
  checkExpr: string | null
  explanation: string
  difficulty: number
}

export type GeneratedNumeric = {
  stem: string
  correctValue: number
  answerIsFraction: boolean
  checkExpr: string
  explanation: string
  difficulty: number
}

export type GeneratedComparison = {
  stem: string
  quantityA: string
  quantityB: string
  relation: 'A' | 'B' | 'equal' | 'undetermined'
  checkA: string | null
  checkB: string | null
  explanation: string
  difficulty: number
}

export type GeneratedTextCompletion = {
  stem: string
  blanks: Array<{ options: string[]; correctIndex: number }>
  explanation: string
  difficulty: number
}

export type GeneratedSentenceEquivalence = {
  stem: string
  options: string[]
  correctIndices: number[]
  explanation: string
  difficulty: number
}

export type GeneratedReading = {
  passage: string
  stem: string
  options: string[]
  correctIndices: number[]
  explanation: string
  difficulty: number
}

export type Generated =
  | GeneratedChoice
  | GeneratedNumeric
  | GeneratedComparison
  | GeneratedTextCompletion
  | GeneratedSentenceEquivalence
  | GeneratedReading

// ------------------------------------------------------------- verifier reply shape

/**
 * The independent solver's reply. It never sees the proposed answer, so
 * `answer` here is genuinely a second opinion rather than an agreement.
 */
export const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    /** How the solver would answer, in the same encoding the question uses. */
    answer: { type: 'string' },
    /** Confidence that the question is well-formed and has exactly one defensible answer. */
    wellFormed: { type: 'boolean' },
    /** What is wrong, when it is not well formed. */
    problem: { type: ['string', 'null'] },
    reasoning: { type: 'string' },
  },
  required: ['answer', 'wellFormed', 'problem', 'reasoning'],
  additionalProperties: false,
} as const

export type VerifierReply = {
  answer: string
  wellFormed: boolean
  problem: string | null
  reasoning: string
}
