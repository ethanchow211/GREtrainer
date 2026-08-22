import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _internals } from '../src/server/verify.ts'
import type { Generated } from '../src/server/schemas.ts'

const { structuralProblems, arithmeticProblems, canonicalAnswer, answersAgree } = _internals

const GOOD_EXPLANATION =
  'Multiply the three factors in order to get the final value, then compare against the original.'

function mc(over: Partial<Record<string, unknown>> = {}): Generated {
  return {
    stem: 'If $x = 4$, what is $3x$?',
    options: ['9', '10', '11', '12', '13'],
    correctIndices: [3],
    correctValue: 12,
    checkExpr: '3*4',
    explanation: GOOD_EXPLANATION,
    difficulty: 2,
    ...over,
  } as Generated
}

function qc(over: Partial<Record<string, unknown>> = {}): Generated {
  return {
    stem: '',
    quantityA: '$2^5$',
    quantityB: '$5^2$',
    relation: 'A',
    checkA: '2^5',
    checkB: '5^2',
    explanation: GOOD_EXPLANATION,
    difficulty: 3,
    ...over,
  } as Generated
}

// ------------------------------------------------------------------------ structure

test('a well-formed multiple choice question has no structural problems', () => {
  assert.deepEqual(structuralProblems('mc', mc()), [])
})

test('catches wrong option counts and out-of-range answers', () => {
  assert.match(structuralProblems('mc', mc({ options: ['1', '2', '3'] })).join(' '), /needs 5 options/)
  assert.match(structuralProblems('mc', mc({ correctIndices: [9] })).join(' '), /outside the option list/)
  assert.match(structuralProblems('mc', mc({ correctIndices: [1, 2] })).join(' '), /exactly 1 correct/)
})

test('catches duplicate options', () => {
  const problems = structuralProblems('mc', mc({ options: ['9', '9', '11', '12', '13'] }))
  assert.match(problems.join(' '), /two options are the same/)
})

test('catches placeholder text, which the model does occasionally emit', () => {
  // This is not hypothetical: a real generation returned exactly this shape.
  const problems = structuralProblems('rc', {
    passage: 'Test passage '.repeat(20),
    stem: 'Test stem',
    options: ['a', 'b', 'c'],
    correctIndices: [0],
    explanation: 'Test explanation that is long enough to clear the length rule easily.',
    difficulty: 3,
  } as Generated)
  assert.match(problems.join(' '), /placeholder text/)
})

test('does not mistake a real question that merely starts with a similar word', () => {
  const problems = structuralProblems('mc', mc({ stem: 'Testing a hypothesis costs $x$ dollars. What is $3x$?' }))
  assert.equal(problems.join(' ').includes('placeholder'), false)
})

test('rejects a stub explanation', () => {
  assert.match(structuralProblems('mc', mc({ explanation: 'Because.' })).join(' '), /too short/)
})

test('sentence equivalence must have six options and exactly two answers', () => {
  const base = {
    stem: 'The critic was ______ in her praise.',
    options: ['a', 'b', 'c', 'd', 'e', 'f'],
    correctIndices: [0, 1],
    explanation: GOOD_EXPLANATION,
    difficulty: 3,
  }
  assert.deepEqual(structuralProblems('se', base as Generated), [])
  assert.match(
    structuralProblems('se', { ...base, correctIndices: [0] } as Generated).join(' '),
    /exactly 2 correct/,
  )
  assert.match(
    structuralProblems('se', { ...base, options: ['a', 'b', 'c', 'd', 'e'] } as Generated).join(' '),
    /needs 6 options/,
  )
  assert.match(
    structuralProblems('se', { ...base, stem: 'No blank here.' } as Generated).join(' '),
    /no blank/,
  )
})

test('multi-blank text completion must mark its blanks in the sentence', () => {
  const blanks = [
    { options: ['a', 'b', 'c'], correctIndex: 0 },
    { options: ['d', 'e', 'f'], correctIndex: 1 },
  ]
  const ok = {
    stem: 'Although the theory was (i)___, its proponents remained (ii)___.',
    blanks,
    explanation: GOOD_EXPLANATION,
    difficulty: 4,
  }
  assert.deepEqual(structuralProblems('tc', ok as Generated), [])

  const missing = { ...ok, stem: 'Although the theory was (i)___, its proponents remained resolute.' }
  assert.match(structuralProblems('tc', missing as Generated).join(' '), /missing the \(ii\) blank marker/)
})

test('single-blank text completion wants five options, multi-blank wants three', () => {
  const one = {
    stem: 'The argument was ______.',
    blanks: [{ options: ['a', 'b', 'c'], correctIndex: 0 }],
    explanation: GOOD_EXPLANATION,
    difficulty: 3,
  }
  assert.match(structuralProblems('tc', one as Generated).join(' '), /needs 5 options/)
})

// ----------------------------------------------------------------------- arithmetic

test('accepts arithmetic that agrees with the stated answer', () => {
  assert.deepEqual(arithmeticProblems('mc', mc()), [])
  assert.deepEqual(arithmeticProblems('qc', qc()), [])
})

test('catches a stated answer that its own arithmetic contradicts', () => {
  const problems = arithmeticProblems('mc', mc({ checkExpr: '3*5', correctValue: 12 }))
  assert.match(problems.join(' '), /gives 15 but the stated answer is 12/)
})

test('catches an answer that does not match the option it points at', () => {
  // Arithmetic and correctValue agree, but they point at the wrong option.
  const problems = arithmeticProblems('mc', mc({ correctIndices: [0] }))
  assert.match(problems.join(' '), /option marked correct reads/)
})

test('catches a quantitative comparison whose claimed relation is wrong', () => {
  // 2^5 = 32, 5^2 = 25, so A really is greater. Claiming B must be caught.
  const problems = arithmeticProblems('qc', qc({ relation: 'B' }))
  assert.match(problems.join(' '), /answer "A"\) but the question claims "B"/)
})

test('catches "undetermined" when both quantities are in fact fixed numbers', () => {
  const problems = arithmeticProblems('qc', qc({ relation: 'undetermined' }))
  assert.match(problems.join(' '), /cannot be "undetermined"/)
})

test('leaves genuinely undetermined comparisons alone', () => {
  // No arithmetic supplied because the quantities depend on an unpinned variable.
  const problems = arithmeticProblems(
    'qc',
    qc({ quantityA: '$x$', quantityB: '$x^2$', relation: 'undetermined', checkA: null, checkB: null }),
  )
  assert.deepEqual(problems, [])
})

test('catches arithmetic that does not evaluate at all', () => {
  const problems = arithmeticProblems('ne', {
    stem: 'x?',
    correctValue: 5,
    answerIsFraction: false,
    checkExpr: 'solve for x',
    explanation: GOOD_EXPLANATION,
    difficulty: 3,
  } as Generated)
  assert.match(problems.join(' '), /does not evaluate/)
})

// ------------------------------------------------------- comparing the two opinions

test('encodes the proposed answer the same way the solver is asked to reply', () => {
  assert.equal(canonicalAnswer('mc', mc()), 'D')
  assert.equal(canonicalAnswer('qc', qc()), 'A')
  assert.equal(
    canonicalAnswer('se', {
      stem: '______',
      options: ['a', 'b', 'c', 'd', 'e', 'f'],
      correctIndices: [4, 1],
      explanation: GOOD_EXPLANATION,
      difficulty: 3,
    } as Generated),
    'B,E',
    'indices are sorted so order never causes a false disagreement',
  )
  assert.equal(
    canonicalAnswer('tc', {
      stem: '(i) (ii)',
      blanks: [
        { options: ['a', 'b', 'c'], correctIndex: 2 },
        { options: ['d', 'e', 'f'], correctIndex: 0 },
      ],
      explanation: GOOD_EXPLANATION,
      difficulty: 4,
    } as Generated),
    'C;A',
  )
})

test('agreement is insensitive to ordering, spacing and quoting', () => {
  assert.equal(answersAgree('se', 'B,E', 'E, B'), true)
  assert.equal(answersAgree('mc', 'D', '"D."'), true)
  assert.equal(answersAgree('tc', 'C;A', 'C; A'), true)
  assert.equal(answersAgree('mc', 'D', 'C'), false)
  assert.equal(answersAgree('se', 'B,E', 'B,F'), false)
})

test('quantitative comparison accepts either the word or the fixed option letter', () => {
  // The four QC options never change, so a solver may answer "C" meaning "equal".
  assert.equal(answersAgree('qc', 'equal', 'C'), true)
  assert.equal(answersAgree('qc', 'undetermined', 'D'), true)
  assert.equal(answersAgree('qc', 'A', 'Quantity A is greater.'), true)
  assert.equal(answersAgree('qc', 'A', 'B'), false)
  assert.equal(answersAgree('qc', 'equal', 'undetermined'), false)
})

test('numeric answers compare by value, not by spelling', () => {
  assert.equal(answersAgree('ne', '0.75', '3/4'), true)
  assert.equal(answersAgree('ne', '12', '12.0'), true)
  assert.equal(answersAgree('ne', '12', '13'), false)
})
