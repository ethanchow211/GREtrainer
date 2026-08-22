/**
 * The map of what the GRE actually tests.
 *
 * Everything else keys off this: what gets generated, what mastery is tracked
 * against, which strategy page is shown after a miss, and how a mock exam is built.
 * Subtopic ids are stable strings and must never be renamed once attempts reference
 * them -- add new ones instead.
 */

export type Section = 'quant' | 'verbal'

/** Answer formats. The UI renders a different input for each. */
export type Format =
  | 'qc' // Quantitative Comparison: compare Quantity A and B, always the same 4 options
  | 'mc' // multiple choice, exactly one correct answer
  | 'ms' // multiple select, one or more correct answers ("select all that apply")
  | 'ne' // numeric entry, type the number, no options
  | 'tc' // Text Completion, 1-3 blanks, one correct word per blank
  | 'se' // Sentence Equivalence, pick exactly 2 words giving the same meaning
  | 'rc' // Reading Comprehension question attached to a passage

/** 1 = easy, 5 = hardest. Roughly maps onto where a question sits in the score range. */
export type Difficulty = 1 | 2 | 3 | 4 | 5

export type Subtopic = {
  id: string
  section: Section
  group: string
  label: string
  formats: Format[]
  /** Guidance handed to the generator so questions look like the real thing. */
  note: string
}

export const SUBTOPICS: Subtopic[] = [
  // ---------------------------------------------------------------- Quant: arithmetic
  {
    id: 'arith.integers',
    section: 'quant',
    group: 'Arithmetic',
    label: 'Integers & divisibility',
    formats: ['qc', 'mc', 'ne'],
    note: 'Factors, multiples, remainders, prime factorisation, consecutive integers, odd/even behaviour.',
  },
  {
    id: 'arith.fractions',
    section: 'quant',
    group: 'Arithmetic',
    label: 'Fractions & decimals',
    formats: ['qc', 'mc', 'ne'],
    note: 'Comparing and manipulating fractions, decimal conversion, complex fractions.',
  },
  {
    id: 'arith.ratios',
    section: 'quant',
    group: 'Arithmetic',
    label: 'Ratios & proportions',
    formats: ['qc', 'mc', 'ne'],
    note: 'Part-to-part vs part-to-whole, scaling, combining ratios, direct and inverse variation.',
  },
  {
    id: 'arith.percents',
    section: 'quant',
    group: 'Arithmetic',
    label: 'Percents',
    formats: ['qc', 'mc', 'ne'],
    note: 'Percent change, successive percent change, percent of a percent. Reversing a percent increase is a classic trap.',
  },
  {
    id: 'arith.exponents',
    section: 'quant',
    group: 'Arithmetic',
    label: 'Exponents & roots',
    formats: ['qc', 'mc', 'ne'],
    note: 'Exponent rules, negative and fractional exponents, simplifying radicals, comparing powers.',
  },
  {
    id: 'arith.numberprops',
    section: 'quant',
    group: 'Arithmetic',
    label: 'Number properties',
    formats: ['qc', 'mc', 'ms'],
    note: 'Sign behaviour, parity, properties that hold for all values vs some values. Good for Quantitative Comparison where the answer is often D.',
  },
  {
    id: 'arith.sequences',
    section: 'quant',
    group: 'Arithmetic',
    label: 'Sequences',
    formats: ['mc', 'ne'],
    note: 'Arithmetic and geometric sequences, recursive definitions, sums of evenly spaced sets.',
  },

  // ------------------------------------------------------------------ Quant: algebra
  {
    id: 'alg.linear',
    section: 'quant',
    group: 'Algebra',
    label: 'Linear equations & systems',
    formats: ['qc', 'mc', 'ne'],
    note: 'Single and simultaneous linear equations, substitution and elimination, under-determined systems.',
  },
  {
    id: 'alg.quadratic',
    section: 'quant',
    group: 'Algebra',
    label: 'Quadratics & factoring',
    formats: ['qc', 'mc', 'ms'],
    note: 'Factoring, difference of squares, the three classic quadratic identities, roots and their sum/product.',
  },
  {
    id: 'alg.inequalities',
    section: 'quant',
    group: 'Algebra',
    label: 'Inequalities',
    formats: ['qc', 'mc', 'ms'],
    note: 'Sign flips on multiplying by a negative, compound inequalities, ranges of possible values.',
  },
  {
    id: 'alg.absolute',
    section: 'quant',
    group: 'Algebra',
    label: 'Absolute value',
    formats: ['qc', 'mc', 'ms'],
    note: 'Two-case reasoning, absolute value inequalities as distance on a number line.',
  },
  {
    id: 'alg.functions',
    section: 'quant',
    group: 'Algebra',
    label: 'Functions & symbols',
    formats: ['mc', 'ne'],
    note: 'Function notation, composed functions, and invented-symbol questions that define an operation on the spot.',
  },
  {
    id: 'alg.wordproblems',
    section: 'quant',
    group: 'Algebra',
    label: 'Word problems',
    formats: ['mc', 'ne'],
    note: 'Rate/time/distance, work rates, mixtures, age, interest. Translating English into an equation is the tested skill.',
  },
  {
    id: 'alg.coordinate',
    section: 'quant',
    group: 'Algebra',
    label: 'Coordinate geometry',
    formats: ['qc', 'mc', 'ne'],
    note: 'Slope, intercepts, distance and midpoint, parallel and perpendicular lines, reflections.',
  },

  // ----------------------------------------------------------------- Quant: geometry
  {
    id: 'geo.angles',
    section: 'quant',
    group: 'Geometry',
    label: 'Lines & angles',
    formats: ['qc', 'mc', 'ne'],
    note: 'Parallel lines cut by a transversal, vertical and supplementary angles, angle sums.',
  },
  {
    id: 'geo.triangles',
    section: 'quant',
    group: 'Geometry',
    label: 'Triangles',
    formats: ['qc', 'mc', 'ne'],
    note: 'Similar triangles, the 3-4-5 and 5-12-13 triples, 30-60-90 and 45-45-90 ratios, the third-side inequality.',
  },
  {
    id: 'geo.polygons',
    section: 'quant',
    group: 'Geometry',
    label: 'Quadrilaterals & polygons',
    formats: ['qc', 'mc', 'ne'],
    note: 'Area and perimeter, interior angle sums, properties of parallelograms and trapezoids.',
  },
  {
    id: 'geo.circles',
    section: 'quant',
    group: 'Geometry',
    label: 'Circles',
    formats: ['qc', 'mc', 'ne'],
    note: 'Arc length, sector area, inscribed vs central angles, tangents.',
  },
  {
    id: 'geo.solids',
    section: 'quant',
    group: 'Geometry',
    label: 'Three-dimensional figures',
    formats: ['qc', 'mc', 'ne'],
    note: 'Volume and surface area of rectangular solids, cylinders, cubes; diagonals through a solid.',
  },

  // ------------------------------------------------------------ Quant: data analysis
  {
    id: 'data.stats',
    section: 'quant',
    group: 'Data analysis',
    label: 'Descriptive statistics',
    formats: ['qc', 'mc', 'ne'],
    note: 'Mean, median, mode, range, quartiles, standard deviation. Comparing mean and median for skewed sets is a favourite.',
  },
  {
    id: 'data.interpretation',
    section: 'quant',
    group: 'Data analysis',
    label: 'Data interpretation',
    formats: ['mc', 'ne', 'ms'],
    note: 'Reading bar charts, line graphs, and tables. Include the data inline as a small table the question refers to.',
  },
  {
    id: 'data.counting',
    section: 'quant',
    group: 'Data analysis',
    label: 'Counting & combinatorics',
    formats: ['mc', 'ne'],
    note: 'Permutations vs combinations, the multiplication principle, arrangements with restrictions.',
  },
  {
    id: 'data.probability',
    section: 'quant',
    group: 'Data analysis',
    label: 'Probability',
    formats: ['qc', 'mc', 'ne'],
    note: 'Independent and mutually exclusive events, complements, at-least problems, simple conditional probability.',
  },
  {
    id: 'data.distributions',
    section: 'quant',
    group: 'Data analysis',
    label: 'Distributions & normal curve',
    formats: ['qc', 'mc'],
    note: 'Normal distribution percentages (roughly 68/95/99.7), percentiles, standard units.',
  },

  // ------------------------------------------------------------- Verbal: completion
  {
    id: 'tc.one',
    section: 'verbal',
    group: 'Text Completion',
    label: 'Text Completion, one blank',
    formats: ['tc'],
    note: 'One sentence, one blank, five options. The sentence must contain a definite clue that forces exactly one answer.',
  },
  {
    id: 'tc.two',
    section: 'verbal',
    group: 'Text Completion',
    label: 'Text Completion, two blanks',
    formats: ['tc'],
    note: 'Two blanks, three options each, no partial credit. Blanks should interact so the pair must be solved together.',
  },
  {
    id: 'tc.three',
    section: 'verbal',
    group: 'Text Completion',
    label: 'Text Completion, three blanks',
    formats: ['tc'],
    note: 'Three blanks, three options each. Usually two to three sentences of dense academic prose.',
  },
  {
    id: 'se.equivalence',
    section: 'verbal',
    group: 'Sentence Equivalence',
    label: 'Sentence Equivalence',
    formats: ['se'],
    note: 'One blank, six options, exactly two correct. The two must be near-synonyms AND both fit the sentence. Include at least one synonym pair that does not fit the sentence, as a trap.',
  },

  // ------------------------------------------------------------ Verbal: comprehension
  {
    id: 'rc.mainidea',
    section: 'verbal',
    group: 'Reading Comprehension',
    label: 'Main idea & primary purpose',
    formats: ['rc'],
    note: 'Asks what the passage as a whole is doing. Wrong answers are usually true but too narrow or too broad.',
  },
  {
    id: 'rc.inference',
    section: 'verbal',
    group: 'Reading Comprehension',
    label: 'Inference',
    formats: ['rc'],
    note: 'What must be true given the passage. The answer must be forced by the text, never merely plausible.',
  },
  {
    id: 'rc.detail',
    section: 'verbal',
    group: 'Reading Comprehension',
    label: 'Detail & explicit statement',
    formats: ['rc', 'ms'],
    note: 'Directly answerable from a specific line. Distractors distort or overstate what the passage says.',
  },
  {
    id: 'rc.tone',
    section: 'verbal',
    group: 'Reading Comprehension',
    label: 'Author attitude & tone',
    formats: ['rc'],
    note: 'Academic prose is rarely extreme; correct answers tend to be measured rather than emphatic.',
  },
  {
    id: 'rc.vocabincontext',
    section: 'verbal',
    group: 'Reading Comprehension',
    label: 'Vocabulary in context',
    formats: ['rc'],
    note: 'A common word used in a secondary sense. The dictionary-first meaning is the trap.',
  },
  {
    id: 'rc.structure',
    section: 'verbal',
    group: 'Reading Comprehension',
    label: 'Passage structure & function',
    formats: ['rc'],
    note: 'What a sentence or paragraph does for the argument, not what it says. Often quotes a phrase in bold.',
  },
  {
    id: 'rc.argument',
    section: 'verbal',
    group: 'Reading Comprehension',
    label: 'Argument: strengthen, weaken, assume',
    formats: ['rc'],
    note: 'Short one-paragraph argument. Test the gap between the evidence and the conclusion.',
  },
]

export const SUBTOPIC_BY_ID = new Map(SUBTOPICS.map((s) => [s.id, s]))

export function subtopicsFor(section: Section): Subtopic[] {
  return SUBTOPICS.filter((s) => s.section === section)
}

export function requireSubtopic(id: string): Subtopic {
  const s = SUBTOPIC_BY_ID.get(id)
  if (!s) throw new Error(`unknown subtopic: ${id}`)
  return s
}

/** The four Quantitative Comparison options never change, so they are not generated. */
export const QC_OPTIONS = [
  'Quantity A is greater.',
  'Quantity B is greater.',
  'The two quantities are equal.',
  'The relationship cannot be determined from the information given.',
] as const

/**
 * The real test, as published by ETS (current shortened format), minus the essay.
 * Used by the mock-exam builder.
 */
export const EXAM_SECTIONS = [
  { section: 'verbal' as const, order: 1, questions: 12, minutes: 18 },
  { section: 'verbal' as const, order: 2, questions: 15, minutes: 23 },
  { section: 'quant' as const, order: 1, questions: 12, minutes: 21 },
  { section: 'quant' as const, order: 2, questions: 15, minutes: 26 },
]
