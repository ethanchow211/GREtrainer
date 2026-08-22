/**
 * Why a question went wrong.
 *
 * This is the most useful signal the app collects. A topic breakdown tells you
 * "you are weak at geometry", which you probably already knew. An error breakdown
 * tells you "41% of your quant misses are arithmetic slips, not concept gaps",
 * which changes what you should actually practise -- and no amount of extra
 * geometry drilling fixes an arithmetic-slip problem.
 *
 * Tags are stable ids. After each miss the app offers Claude's diagnosis as the
 * pre-selected default, so recording one is a single click.
 */

export type ErrorTag = {
  id: string
  section: 'quant' | 'verbal' | 'both'
  label: string
  /** Shown under the label when tagging. */
  hint: string
  /** Strategy pages that address this failure, by filename stem. */
  strategies: string[]
}

export const ERROR_TAGS: ErrorTag[] = [
  {
    id: 'concept',
    section: 'both',
    label: "Didn't know the concept",
    hint: 'You did not know the rule, formula, or method needed. Not a slip -- a genuine gap.',
    strategies: [],
  },
  {
    id: 'arithmetic',
    section: 'quant',
    label: 'Arithmetic slip',
    hint: 'You knew exactly what to do and mis-multiplied, dropped a sign, or mis-copied a number.',
    strategies: ['Arithmetic Slip Discipline'],
  },
  {
    id: 'misread',
    section: 'both',
    label: 'Misread the question',
    hint: 'You solved a real problem, just not the one asked -- found x when it wanted 2x, or missed an "except".',
    strategies: ['Reading The Question Twice'],
  },
  {
    id: 'trap',
    section: 'both',
    label: 'Fell for a trap answer',
    hint: 'You picked the option placed there for exactly the mistake you made.',
    strategies: ['Trap Answer Patterns', 'Quantitative Comparison Traps'],
  },
  {
    id: 'incomplete',
    section: 'quant',
    label: 'Stopped one step early',
    hint: 'Your work was right but you answered an intermediate quantity.',
    strategies: ['Reading The Question Twice'],
  },
  {
    id: 'method',
    section: 'quant',
    label: 'Slow or wrong method',
    hint: 'You could have got there, but the approach was the long way round and time ran out.',
    strategies: ['Plugging In Numbers', 'Backsolving From The Options', 'When To Skip'],
  },
  {
    id: 'undetermined',
    section: 'quant',
    label: 'Missed that it was undetermined',
    hint: 'You assumed values the question never fixed -- forgot negatives, fractions, or zero.',
    strategies: ['Quantitative Comparison Traps'],
  },
  {
    id: 'vocab',
    section: 'verbal',
    label: "Didn't know the word",
    hint: 'One or more options were words you could not define.',
    strategies: ['Learning Words That Pay'],
  },
  {
    id: 'clue',
    section: 'verbal',
    label: 'Missed the clue in the sentence',
    hint: 'The sentence contained a contrast or restatement that forced the answer, and you did not use it.',
    strategies: ['Finding The Clue Word', 'Text Completion Method'],
  },
  {
    id: 'pair',
    section: 'verbal',
    label: 'Broke the synonym-pair rule',
    hint: 'On Sentence Equivalence you picked two words that fit but do not mean the same thing -- or took a synonym pair that did not fit.',
    strategies: ['Sentence Equivalence By Pairs'],
  },
  {
    id: 'scope',
    section: 'verbal',
    label: 'Answer went beyond the passage',
    hint: 'You picked something plausible or true rather than something the passage forces.',
    strategies: ['Inference Means Must Be True', 'Trap Answer Patterns'],
  },
  {
    id: 'extreme',
    section: 'verbal',
    label: 'Picked an over-strong answer',
    hint: 'The option used absolutes the measured academic passage never supported.',
    strategies: ['Trap Answer Patterns'],
  },
  {
    id: 'time',
    section: 'both',
    label: 'Ran out of time',
    hint: 'You would have got it with another minute. A pacing problem, not a knowledge problem.',
    strategies: ['Pacing And The Clock', 'When To Skip'],
  },
  {
    id: 'guess',
    section: 'both',
    label: 'Guessed',
    hint: 'No real reasoning behind the choice.',
    strategies: [],
  },
  {
    id: 'careless-other',
    section: 'both',
    label: 'Careless, other',
    hint: 'You knew it and got it wrong anyway, in a way none of the above describes.',
    strategies: [],
  },
]

export const ERROR_TAG_BY_ID = new Map(ERROR_TAGS.map((t) => [t.id, t]))

export function errorTagsFor(section: 'quant' | 'verbal'): ErrorTag[] {
  return ERROR_TAGS.filter((t) => t.section === section || t.section === 'both')
}
