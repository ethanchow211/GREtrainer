import type { Format } from '../content/taxonomy.ts'
import type {
  Generated,
  GeneratedReading,
  GeneratedSentenceEquivalence,
  GeneratedTextCompletion,
} from './schemas.ts'

/**
 * Putting the answer choices of verbal questions in a random order.
 *
 * Why this exists: Claude writes the correct answer near the top of the list far
 * more often than chance would. Before this file, 96 of 111 Text Completion blanks
 * had "A" as the answer, and Reading questions were nearly always A or B. A
 * test-taker learns that pattern within a few questions, which defeats the drill.
 *
 * Shuffling the options is easy. The fiddly part is that the explanation names
 * options by letter ("Option B overstates...", "nebulous (A)"), so those letters
 * must be rewritten to match the new order. If any letter in the explanation
 * cannot be identified with confidence, the question is left exactly as written:
 * a biased order is a much smaller harm than an explanation pointing at the wrong
 * answer.
 *
 * Quant formats are deliberately not shuffled. The real GRE lists numeric answers
 * in ascending order, and the generator follows that convention.
 */

const LETTERS = 'ABCDEFGH'

/** The formats this file shuffles. */
export const SHUFFLED_FORMATS: readonly Format[] = ['rc', 'se', 'tc']

/** A random ordering of 0..count-1 (the Fisher-Yates shuffle: unbiased, one pass). */
export function randomOrder(count: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length: count }, (_, i) => i)
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const held = order[i] as number
    order[i] = order[j] as number
    order[j] = held
  }
  return order
}

/**
 * `order[newPosition] = oldPosition`. This turns it the other way round, so you can
 * ask "where did old option 2 end up?".
 */
function newPositionOf(order: number[]): number[] {
  const where: number[] = []
  order.forEach((oldPosition, newPosition) => {
    where[oldPosition] = newPosition
  })
  return where
}

// ------------------------------------------------------ rewriting letters in prose

/**
 * A capital A-H standing on its own, not part of a word ("B", "(C)", "D," but not
 * "BC", "Bach" or "U.S.").
 */
const LONE_LETTER = /(?<![A-Za-z0-9'’$\\{.])([A-H])(?![A-Za-z0-9'’])/g

/** Text just before a letter that marks it as naming an option: "option ", "choices ". */
const OPTION_WORD_BEFORE = /\b(?:options?|choices?|answers?)\s+$/i

/** The same, but continuing a list: "options A, C, and " / "choices B or ". */
const OPTION_LIST_BEFORE =
  /\b(?:options?|choices?|answers?)\s+(?:\(?[A-H]\)?(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+))+$/i

/**
 * Decide, for every lone letter in `text`, which option it names. Returns null if
 * any lone letter is ambiguous -- that is the signal to leave the question alone.
 *
 * `resolve` is given each confidently-identified reference and returns its new
 * letter, or null when it cannot work one out (also a reason to give up).
 */
function rewriteLetters(
  text: string,
  resolve: (letter: string, matchStart: number) => string | null,
): string | null {
  // First pass: sort every lone letter into "names an option" or "something else".
  const found: Array<{ start: number; letter: string; isReference: boolean }> = []

  for (const match of text.matchAll(LONE_LETTER)) {
    const start = match.index
    const letter = match[1] as string
    const before = text.slice(Math.max(0, start - 60), start)
    const after = text.slice(start + 1, start + 30)

    const inBrackets = before.endsWith('(') && after.startsWith(')')
    const afterOptionWord = OPTION_WORD_BEFORE.test(before) || OPTION_LIST_BEFORE.test(before)
    found.push({ start, letter, isReference: inBrackets || afterOptionWord })
  }

  // Second pass: rewrite references, and make sure every other lone letter is
  // safely the English word "A" ("A claim escapes testing...").
  let result = ''
  let copiedUpTo = 0
  for (const item of found) {
    if (!item.isReference) {
      if (item.letter !== 'A') return null // a bare "C" or "B and" -- can't tell what it names
      const nextWord = /^\s+([A-Za-z]+)/.exec(text.slice(item.start + 1))?.[1]
      // "A claim" is the English word. "A is wrong", "A overstates" or "A, ..."
      // might be the option. Anything that could be a verb counts as doubt, even
      // though that also refuses a few genuine articles ("A thesis").
      const looksLikeArticle = nextWord !== undefined && /^[a-z]/.test(nextWord)
      const couldBeVerb =
        nextWord !== undefined &&
        (/s$/.test(nextWord) || /^(and|or|but|is|was|would|does|can|could|might|may|also)$/.test(nextWord))
      if (!looksLikeArticle || couldBeVerb) return null
      continue
    }

    const replacement = resolve(item.letter, item.start)
    if (replacement === null) return null
    result += text.slice(copiedUpTo, item.start) + replacement
    copiedUpTo = item.start + 1
  }
  return result + text.slice(copiedUpTo)
}

/** Rewrite letters for a question with one option list. */
function rewriteForOneList(text: string, order: number[]): string | null {
  const where = newPositionOf(order)
  return rewriteLetters(text, (letter) => {
    const oldPosition = LETTERS.indexOf(letter)
    if (oldPosition < 0 || oldPosition >= order.length) return null // names an option that does not exist
    return LETTERS[where[oldPosition] as number] as string
  })
}

/**
 * Rewrite letters for a Text Completion question. Each blank has its own A-B-C list,
 * so "(A)" means nothing until we know which blank it belongs to. The explanation
 * writes "nebulous (A)", so we look at the word just before the bracket and find
 * the blank whose option at that letter is that word.
 */
function rewriteForBlanks(text: string, blanks: Array<{ options: string[] }>, orders: number[][]): string | null {
  const wheres = orders.map(newPositionOf)

  return rewriteLetters(text, (letter, start) => {
    const oldPosition = LETTERS.indexOf(letter)

    if (blanks.length === 1) {
      if (oldPosition < 0 || oldPosition >= (orders[0] as number[]).length) return null
      return LETTERS[(wheres[0] as number[])[oldPosition] as number] as string
    }

    // Several blanks: the letter must sit in brackets right after the option's own
    // wording, e.g. `"dismissed" (A)` or `fanciful (B)`.
    const before = text.slice(Math.max(0, start - 80), start)
    const wordBefore = /([A-Za-z][A-Za-z\- ]*?)["'”’]?\s*\($/.exec(before)?.[1]?.trim().toLowerCase()
    if (!wordBefore) return null

    const matchingBlanks = blanks
      .map((blank, blankIndex) => ({ blankIndex, option: blank.options[oldPosition] }))
      .filter((c) => c.option !== undefined && wordBefore.endsWith(c.option.trim().toLowerCase()))
    if (matchingBlanks.length !== 1) return null // no blank fits, or more than one does

    const blankIndex = (matchingBlanks[0] as { blankIndex: number }).blankIndex
    return LETTERS[(wheres[blankIndex] as number[])[oldPosition] as number] as string
  })
}

// ------------------------------------------------------------------ the shuffle

/**
 * A copy of `q` with its options in a random order, its answer indices moved to
 * match, and the letters in its explanation rewritten. Returns `q` itself, untouched,
 * for formats that are not shuffled or when the explanation cannot be safely
 * rewritten.
 */
export function shuffleChoices(format: Format, q: Generated, random: () => number = Math.random): Generated {
  if (format === 'rc' || format === 'se') {
    const d = q as GeneratedReading | GeneratedSentenceEquivalence
    const order = randomOrder(d.options.length, random)
    const where = newPositionOf(order)

    const explanation = rewriteForOneList(d.explanation, order)
    if (explanation === null) return q

    return {
      ...d,
      options: order.map((oldPosition) => d.options[oldPosition] as string),
      correctIndices: d.correctIndices.map((oldPosition) => where[oldPosition] as number).sort((a, b) => a - b),
      explanation,
    }
  }

  if (format === 'tc') {
    const d = q as GeneratedTextCompletion
    const orders = d.blanks.map((blank) => randomOrder(blank.options.length, random))

    const explanation = rewriteForBlanks(d.explanation, d.blanks, orders)
    if (explanation === null) return q

    return {
      ...d,
      blanks: d.blanks.map((blank, blankIndex) => {
        const order = orders[blankIndex] as number[]
        return {
          options: order.map((oldPosition) => blank.options[oldPosition] as string),
          correctIndex: newPositionOf(order)[blank.correctIndex] as number,
        }
      }),
      explanation,
    }
  }

  return q
}

export const _internals = { rewriteForOneList, rewriteForBlanks, newPositionOf }
