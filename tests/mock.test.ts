import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'gre-mock-'))
process.env.GRE_DB_PATH = join(scratch, 'test.db')

const { adaptiveTarget, estimateScore, wasSkipped } = await import('../src/server/mock.ts')
const { EXAM_SECTIONS } = await import('../src/content/taxonomy.ts')

after(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* Windows may still hold the file open; the temp directory is cleaned anyway. */
  }
})

test('the second section gets harder when the first went well', () => {
  assert.equal(adaptiveTarget(12, 12), 5, 'a perfect first section earns the hardest material')
  assert.equal(adaptiveTarget(9, 12), 4)
  assert.equal(adaptiveTarget(6, 12), 3)
  assert.equal(adaptiveTarget(2, 12), 2, 'a poor first section drops the difficulty')
})

test('adaptive difficulty is monotonic', () => {
  let previous = 0
  for (let correct = 0; correct <= 12; correct++) {
    const level = adaptiveTarget(correct, 12)
    assert.ok(level >= previous, `answering more correctly should never lower the target (${correct}/12)`)
    previous = level
  }
})

test('an empty section does not divide by zero', () => {
  assert.equal(adaptiveTarget(0, 0), 3)
})

function fakeExam(section: 'quant' | 'verbal', results: Array<{ correct: number; total: number; level: number }>) {
  return {
    id: 'x',
    createdAt: '',
    current: 0,
    finished: true,
    sections: results.map((r, i) => ({
      index: i,
      section,
      order: (i + 1) as 1 | 2,
      minutes: 20,
      questions: Array.from({ length: r.total }, () => ({}) as never),
      startedAt: null,
      submittedAt: 'now',
      correct: r.correct,
      level: r.level,
    })),
  }
}

test('score estimates stay inside the real 130-170 range', () => {
  const perfect = estimateScore(fakeExam('quant', [{ correct: 12, total: 12, level: 5 }]), 'quant')
  assert.ok(perfect.score <= 170, `score exceeded the scale: ${perfect.score}`)

  const nothing = estimateScore(fakeExam('quant', [{ correct: 0, total: 12, level: 1 }]), 'quant')
  assert.ok(nothing.score >= 130, `score fell below the scale: ${nothing.score}`)
})

test('answering more correctly never lowers the estimated score', () => {
  let previous = 0
  for (let correct = 0; correct <= 27; correct++) {
    const s = estimateScore(fakeExam('verbal', [{ correct, total: 27, level: 3 }]), 'verbal')
    assert.ok(s.score >= previous, `score dropped at ${correct}/27`)
    previous = s.score
  }
})

test('harder material scores higher at the same accuracy', () => {
  const easy = estimateScore(fakeExam('quant', [{ correct: 18, total: 27, level: 2 }]), 'quant')
  const hard = estimateScore(fakeExam('quant', [{ correct: 18, total: 27, level: 5 }]), 'quant')
  assert.ok(hard.score > easy.score, 'the test is section-adaptive; harder questions should count for more')
})

test('an unstarted measure reports the floor rather than crashing', () => {
  const s = estimateScore(fakeExam('quant', []), 'quant')
  assert.equal(s.score, 130)
  assert.equal(s.total, 0)
})

test('both sections of a measure are counted together', () => {
  const s = estimateScore(
    fakeExam('quant', [
      { correct: 10, total: 12, level: 3 },
      { correct: 12, total: 15, level: 4 },
    ]),
    'quant',
  )
  assert.equal(s.correct, 22)
  assert.equal(s.total, 27, 'a full quant measure is 12 + 15 questions')
})

test('the mock blueprint is the real one', () => {
  assert.equal(EXAM_SECTIONS.length, 4, 'two Verbal and two Quant sections, no essay')
  for (const s of EXAM_SECTIONS) {
    assert.ok(s.order === 1 || s.order === 2)
    assert.ok(s.questions > 0 && s.minutes > 0)
  }
})

test('a section skipped for want of questions is excluded, not counted as zero', () => {
  // The pool ran dry, so the second section never got built. Scoring it as 0/15
  // would report a failure that never happened.
  const exam = fakeExam('verbal', [
    { correct: 10, total: 12, level: 4 },
    { correct: 0, total: 0, level: 3 },
  ])
  const s = estimateScore(exam as never, 'verbal')
  assert.equal(s.total, 12, 'only the section actually taken counts')
  assert.equal(s.correct, 10)

  const takenOnly = estimateScore(fakeExam('verbal', [{ correct: 10, total: 12, level: 4 }]) as never, 'verbal')
  assert.equal(s.score, takenOnly.score, 'an empty section must not drag the score or the difficulty down')
})

test('wasSkipped distinguishes an unfilled section from one that was taken', () => {
  assert.equal(wasSkipped({ submittedAt: 'now', questions: [] } as never), true)
  assert.equal(wasSkipped({ submittedAt: 'now', questions: [{}] } as never), false)
  assert.equal(wasSkipped({ submittedAt: null, questions: [] } as never), false, 'not yet built is not skipped')
})
