import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shuffleChoices, randomOrder } from '../src/server/shuffle.ts'
import type {
  Generated,
  GeneratedChoice,
  GeneratedReading,
  GeneratedSentenceEquivalence,
  GeneratedTextCompletion,
} from '../src/server/schemas.ts'

/**
 * A repeatable stand-in for Math.random, so a failing test fails the same way every
 * time. (A simple "linear congruential" generator: good enough to spread numbers
 * evenly, not meant for anything secret.)
 */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function reading(over: Partial<GeneratedReading> = {}): GeneratedReading {
  return {
    passage: 'A passage long enough to matter.',
    stem: 'Which of the following best states the main point?',
    options: ['first', 'second', 'third', 'fourth', 'fifth'],
    correctIndices: [0],
    explanation: 'Option A is right because it names the whole argument. Option B overstates it.',
    difficulty: 3,
    ...over,
  }
}

test('the correct answer lands on every letter about equally often', () => {
  // The bug: Claude nearly always put the answer first. After shuffling, an answer
  // written in position A should end up on each of the five letters ~20% of the time.
  const random = seeded(42)
  const counts = [0, 0, 0, 0, 0]
  const trials = 5000
  for (let i = 0; i < trials; i++) {
    const out = shuffleChoices('rc', reading(), random) as GeneratedReading
    const landed = out.correctIndices[0] as number
    counts[landed] = (counts[landed] ?? 0) + 1
  }
  for (const count of counts) {
    const share = count / trials
    assert.ok(share > 0.17 && share < 0.23, `share ${share} is not close to 0.2 (counts ${counts})`)
  }
})

test('shuffling keeps the right option marked correct and loses nothing', () => {
  const random = seeded(7)
  for (let i = 0; i < 50; i++) {
    const before = reading({ correctIndices: [1] })
    const after = shuffleChoices('rc', before, random) as GeneratedReading
    assert.deepEqual([...after.options].sort(), [...before.options].sort())
    assert.equal(after.options[after.correctIndices[0] as number], 'second')
  }
})

test('letters in the explanation follow their options to the new positions', () => {
  const random = seeded(3)
  for (let i = 0; i < 50; i++) {
    const before = reading()
    const after = shuffleChoices('rc', before, random) as GeneratedReading
    const newA = 'ABCDE'[after.options.indexOf('first')]
    const newB = 'ABCDE'[after.options.indexOf('second')]
    assert.equal(
      after.explanation,
      `Option ${newA} is right because it names the whole argument. Option ${newB} overstates it.`,
    )
  }
})

test('lists of letters and bracketed letters are all rewritten', () => {
  const se: GeneratedSentenceEquivalence = {
    stem: 'The reply was ______.',
    options: ['equivocal', 'evasive', 'candid', 'frank', 'terse', 'loud'],
    correctIndices: [0, 1],
    explanation: 'Equivocal (A) and evasive (B) both fit. Options C, D, and E point the other way. A careful reader sees it.',
    difficulty: 3,
  }
  const after = shuffleChoices('se', se, seeded(11)) as GeneratedSentenceEquivalence
  const letterOf = (word: string) => 'ABCDEF'[after.options.indexOf(word)]
  assert.equal(
    after.explanation,
    `Equivocal (${letterOf('equivocal')}) and evasive (${letterOf('evasive')}) both fit. ` +
      `Options ${letterOf('candid')}, ${letterOf('frank')}, and ${letterOf('terse')} point the other way. ` +
      'A careful reader sees it.',
  )
  assert.deepEqual(
    after.correctIndices,
    [after.options.indexOf('equivocal'), after.options.indexOf('evasive')].sort((a, b) => a - b),
  )
})

test('a bare letter that might not name an option leaves the question untouched', () => {
  // "B is wrong" could be rewritten, but "A does" might be the option or the word
  // "a". Rather than guess, the whole question keeps its original order.
  for (const explanation of [
    'Option A is right. B is wrong because it overreaches.',
    'The answer is option C. A does not follow from the passage.',
  ]) {
    const before = reading({ explanation })
    assert.equal(shuffleChoices('rc', before, seeded(1)), before)
  }
})

test('text completion: each blank is shuffled on its own, letters matched by word', () => {
  const tc: GeneratedTextCompletion = {
    stem: 'The critics (i) the claim, but the data (ii) it.',
    blanks: [
      { options: ['dismissed', 'embraced', 'ignored'], correctIndex: 0 },
      { options: ['vindicated', 'undermined', 'obscured'], correctIndex: 0 },
    ],
    explanation: 'The first blank needs "dismissed" (A); embraced (B) reverses it. The second needs vindicated (A).',
    difficulty: 3,
  }
  const after = shuffleChoices('tc', tc, seeded(5)) as GeneratedTextCompletion
  const first = after.blanks[0] as { options: string[]; correctIndex: number }
  const second = after.blanks[1] as { options: string[]; correctIndex: number }
  assert.equal(first.options[first.correctIndex], 'dismissed')
  assert.equal(second.options[second.correctIndex], 'vindicated')
  const letter = (blank: { options: string[] }, word: string) => 'ABC'[blank.options.indexOf(word)]
  assert.equal(
    after.explanation,
    `The first blank needs "dismissed" (${letter(first, 'dismissed')}); embraced (${letter(first, 'embraced')}) reverses it. ` +
      `The second needs vindicated (${letter(second, 'vindicated')}).`,
  )
})

test('quant questions are never shuffled', () => {
  // The GRE lists numeric answers in order, and the generator does too.
  const mc: GeneratedChoice = {
    stem: 'What is 3 times 4?',
    options: ['9', '10', '11', '12', '13'],
    correctIndices: [3],
    correctValue: 12,
    checkExpr: '3*4',
    explanation: 'Multiply. Option D is 12.',
    difficulty: 1,
  }
  assert.equal(shuffleChoices('mc', mc as Generated, seeded(2)), mc)
})

test('randomOrder is a true rearrangement', () => {
  const order = randomOrder(8, seeded(9))
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7])
})
