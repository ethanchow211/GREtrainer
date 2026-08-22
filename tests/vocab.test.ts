import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'gre-vocab-'))
process.env.GRE_DB_PATH = join(scratch, 'test.db')

const { wordsFrom, addWords, dueCards, reviewCard, vocabStats, pendingWords } = await import(
  '../src/server/vocab.ts'
)

after(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* Windows may still hold the file; the temp directory gets cleaned anyway. */
  }
})

function seQuestion(options: string[]) {
  return {
    id: 'q1',
    section: 'verbal',
    subtopic: 'se.equivalence',
    format: 'se',
    difficulty: 3,
    payload: { stem: 'The critic was ______.', options, correctIndices: [0, 1], explanation: 'x', difficulty: 3 },
    explanation: 'x',
    status: 'verified',
    rejectReason: null,
    createdAt: '',
    firstServedAt: null,
  }
}

test('every option becomes a candidate word, not just the correct ones', () => {
  // The trap pair is usually the vocabulary actually worth learning.
  const words = wordsFrom(seQuestion(['Apocryphal', 'spurious', 'controversial', 'contentious', 'meticulous', 'definitive']) as never)
  assert.equal(words.length, 6)
  assert.ok(words.includes('controversial'), 'a wrong option is still worth learning')
})

test('words are normalised so the same word cannot land twice', () => {
  const words = wordsFrom(seQuestion(['Apocryphal', 'apocryphal ', 'APOCRYPHAL', 'spurious', 'x', 'y']) as never)
  assert.deepEqual(words, ['apocryphal', 'spurious'], 'case and spacing collapse; short tokens are dropped')
})

test('very short words are skipped', () => {
  const words = wordsFrom(seQuestion(['apt', 'shy', 'wan', 'odd', 'laconic', 'verbose']) as never)
  assert.deepEqual(words.sort(), ['laconic', 'verbose'])
})

test('quant questions contribute no vocabulary', () => {
  const quant = { ...seQuestion(['a', 'b', 'c', 'd', 'e', 'f']), format: 'mc' }
  assert.deepEqual(wordsFrom(quant as never), [])
})

test('adding the same word twice does not reset its schedule', () => {
  assert.equal(addWords(['laconic', 'verbose'], 'q1'), 2)
  assert.equal(addWords(['laconic', 'verbose'], 'q2'), 0, 'already present, so nothing added')
  assert.equal(vocabStats().total, 2)
})

test('a word with no definition yet is never served for review', () => {
  // Definitions are written in batches in the background, so a freshly collected
  // word sits in the deck unusable for a while. Showing it would be a blank card.
  assert.equal(vocabStats().pending, 2)
  assert.deepEqual(dueCards(), [], 'nothing is reviewable until it has a definition')
  assert.deepEqual(pendingWords().sort(), ['laconic', 'verbose'])
})

test('once defined, a word becomes due', async () => {
  const { db } = await import('../src/server/db.ts')
  db.prepare("UPDATE vocab SET definition = 'using few words (neutral)' WHERE word = 'laconic'").run()

  const due = dueCards()
  assert.equal(due.length, 1)
  assert.equal(due[0]?.word, 'laconic')
  assert.equal(vocabStats().pending, 1)
})

test('knowing a word pushes it further out; not knowing it brings it back', () => {
  const known = reviewCard('laconic', 'yes')
  assert.ok(known)
  assert.equal(known.reps, 1)
  assert.ok(new Date(known.dueAt).getTime() > Date.now(), 'a known word is not due again immediately')

  const first = known.intervalDays
  const again = reviewCard('laconic', 'yes')
  assert.ok((again?.intervalDays ?? 0) > first, 'intervals keep widening while you keep knowing it')

  const forgotten = reviewCard('laconic', 'no')
  assert.equal(forgotten?.intervalDays, 1, 'forgetting brings it back tomorrow')
  assert.equal(forgotten?.reps, 0)
  assert.equal(forgotten?.lapses, 1)
})

test('"roughly" is treated as weaker than "yes"', async () => {
  const { db } = await import('../src/server/db.ts')
  addWords(['perfunctory'], 'q3')
  db.prepare("UPDATE vocab SET definition = 'done without care (negative)' WHERE word = 'perfunctory'").run()

  const rough = reviewCard('perfunctory', 'hard')
  assert.ok(rough)
  // Both count as remembered, so reps advance, but a shaky recall must not make
  // the word easier to graduate.
  assert.equal(rough.reps, 1)
  assert.ok(rough.ease <= 2.5)
})

test('reviewing a word that is not in the deck reports nothing rather than throwing', () => {
  assert.equal(reviewCard('notarealword', 'yes'), null)
})
