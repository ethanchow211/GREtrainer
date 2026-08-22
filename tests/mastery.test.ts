import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the database somewhere disposable BEFORE anything imports it, so these
// tests never touch real study progress.
const scratch = mkdtempSync(join(tmpdir(), 'gre-test-'))
process.env.GRE_DB_PATH = join(scratch, 'test.db')

const { recordMastery, getMastery, needScore, nextSchedule, qualityFrom } = await import(
  '../src/server/mastery.ts'
)
const { targetDifficulty } = await import('../src/server/select.ts')

after(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* Windows sometimes still holds the file; the temp directory gets cleaned anyway. */
  }
})

// ------------------------------------------------------------------------ mastery

test('an unmeasured subtopic starts at even odds with high uncertainty', () => {
  const m = getMastery('arith.percents')
  assert.equal(m.mean, 0.5)
  assert.equal(m.attempts, 0)
  assert.ok(m.sd > 0.2, 'a fresh estimate should be very uncertain')
})

test('correct answers raise the estimate, wrong answers lower it', () => {
  const start = getMastery('geo.circles').mean
  const afterRight = recordMastery('geo.circles', true, 3)
  assert.ok(afterRight.mean > start)

  const afterWrong = recordMastery('geo.circles', false, 3)
  assert.ok(afterWrong.mean < afterRight.mean)
})

test('uncertainty shrinks as attempts accumulate', () => {
  const before = getMastery('alg.linear').sd
  for (let i = 0; i < 20; i++) recordMastery('alg.linear', i % 2 === 0, 3)
  const now = getMastery('alg.linear')
  assert.ok(now.sd < before, 'twenty answers should tighten the estimate')
  assert.equal(now.attempts, 20)
})

test('harder questions move the estimate more than easy ones', () => {
  const easy = recordMastery('data.counting', true, 1)
  const easyGain = easy.mean - 0.5

  const hardStart = getMastery('data.probability')
  const hard = recordMastery('data.probability', true, 5)
  const hardGain = hard.mean - hardStart.mean

  assert.ok(hardGain > easyGain, 'getting a hard question right should count for more')
})

test('a small sample does not look like settled fact', () => {
  // Two right out of two is 100% by naive counting, but should not read as mastery.
  recordMastery('geo.solids', true, 3)
  recordMastery('geo.solids', true, 3)
  const m = getMastery('geo.solids')
  assert.ok(m.mean < 0.85, `two correct answers should not imply mastery, got ${m.mean}`)
})

test('need is driven by both weakness and how little we have measured', () => {
  const unmeasured = getMastery('rc.tone')

  // Make one subtopic reliably strong.
  for (let i = 0; i < 30; i++) recordMastery('arith.fractions', true, 3)
  const strong = getMastery('arith.fractions')

  // And another reliably weak.
  for (let i = 0; i < 30; i++) recordMastery('arith.sequences', false, 3)
  const weak = getMastery('arith.sequences')

  assert.ok(needScore(weak) > needScore(unmeasured), 'a measured weakness beats an unknown')
  assert.ok(needScore(unmeasured) > needScore(strong), 'an unknown beats a measured strength')
})

test('difficulty tracks how well you are doing', () => {
  const weak = { subtopic: 'x', alpha: 1, beta: 9, attempts: 10, mean: 0.1, sd: 0.09 }
  const strong = { subtopic: 'x', alpha: 9, beta: 1, attempts: 10, mean: 0.9, sd: 0.09 }
  assert.ok(targetDifficulty(weak) < targetDifficulty(strong))
  assert.equal(targetDifficulty(strong), 5)
})

// --------------------------------------------------------------------- scheduling

test('a first correct answer schedules a day out, then six', () => {
  const first = nextSchedule(null, 5)
  assert.equal(first.intervalDays, 1)
  assert.equal(first.reps, 1)

  const second = nextSchedule(first, 5)
  assert.equal(second.intervalDays, 6)
  assert.equal(second.reps, 2)

  const third = nextSchedule(second, 5)
  assert.ok(third.intervalDays > 6, 'intervals keep growing while you keep getting it right')
})

test('getting it wrong collapses the interval and makes it harder to graduate', () => {
  let s = nextSchedule(null, 5)
  s = nextSchedule(s, 5)
  s = nextSchedule(s, 5)
  const easeBefore = s.ease
  const longInterval = s.intervalDays

  const lapsed = nextSchedule(s, 1)
  assert.equal(lapsed.intervalDays, 1, 'a miss brings it back tomorrow')
  assert.equal(lapsed.reps, 0)
  assert.equal(lapsed.lapses, 1)
  assert.ok(lapsed.ease < easeBefore, 'ease drops after a lapse')
  assert.ok(longInterval > 1)
})

test('ease never falls below the floor no matter how often you miss', () => {
  let s = nextSchedule(null, 0)
  for (let i = 0; i < 50; i++) s = nextSchedule(s, 0)
  assert.ok(s.ease >= 1.3, `ease floor breached: ${s.ease}`)
})

test('the due date matches the interval', () => {
  const now = new Date('2026-08-22T12:00:00.000Z')
  const s = nextSchedule(null, 5, now)
  const due = new Date(s.dueAt).getTime() - now.getTime()
  assert.equal(Math.round(due / (24 * 60 * 60 * 1000)), 1)
})

test('answer quality reflects both correctness and speed', () => {
  assert.equal(qualityFrom(false, 30, 3), 2, 'wrong is always a lapse')
  assert.ok(qualityFrom(false, 200, 3) < 3)

  const fast = qualityFrom(true, 10, 3)
  const slow = qualityFrom(true, 300, 3)
  assert.ok(fast > slow, 'a quick correct answer should count for more than a laboured one')
  assert.ok(slow >= 3, 'a slow correct answer is still not a lapse')
})

test('the par time scales with difficulty', () => {
  // 70 seconds is slow for an easy question but fine for a hard one.
  assert.ok(qualityFrom(true, 70, 1) < qualityFrom(true, 70, 5))
})
