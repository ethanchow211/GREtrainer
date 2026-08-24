import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the database somewhere disposable BEFORE anything imports it, so these
// tests never touch real study progress.
const scratch = mkdtempSync(join(tmpdir(), 'gre-select-'))
process.env.GRE_DB_PATH = join(scratch, 'test.db')

const { newSession, targetSection, chooseSubtopic, noteServed } = await import('../src/server/select.ts')
const { refillPlan } = await import('../src/server/buffer.ts')
const { requireSubtopic, subtopicsFor } = await import('../src/content/taxonomy.ts')
const { recordMastery } = await import('../src/server/mastery.ts')

after(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* Windows sometimes still holds the file; the temp directory gets cleaned anyway. */
  }
})

/** A stand-in for a served question; only the fields noteServed reads matter. */
function fakeQuestion(subtopic: string, n: number) {
  const sub = requireSubtopic(subtopic)
  return {
    id: `q${n}`,
    section: sub.section,
    subtopic,
    format: sub.formats[0]!,
    difficulty: 3,
    payload: {} as never,
    explanation: '',
    status: 'verified' as const,
    rejectReason: null,
    createdAt: '',
    firstServedAt: null,
  }
}

// ------------------------------------------------------------------- the even split

test('a mixed session alternates sections, never drifting by more than one', () => {
  const state = newSession('both')
  const counts = { quant: 0, verbal: 0 }

  for (let i = 0; i < 200; i++) {
    const section = targetSection(state)
    const subtopic = chooseSubtopic(state, section)
    // Whatever weakness picked, it has to belong to the section whose turn it was.
    assert.equal(requireSubtopic(subtopic).section, section)

    counts[section] += 1
    assert.ok(Math.abs(counts.quant - counts.verbal) <= 1, `drifted at question ${i}`)

    noteServed(state, fakeQuestion(subtopic, i), 'drill')
  }

  assert.equal(counts.quant, 100)
  assert.equal(counts.verbal, 100)
})

test('a single-section session stays in that section', () => {
  for (const only of ['quant', 'verbal'] as const) {
    const state = newSession(only)
    for (let i = 0; i < 20; i++) {
      assert.equal(targetSection(state), only)
      const subtopic = chooseSubtopic(state, only)
      assert.equal(requireSubtopic(subtopic).section, only)
      noteServed(state, fakeQuestion(subtopic, i), 'drill')
    }
  }
})

test('weakness still steers the choice inside a section', () => {
  // One quant subtopic driven to near-zero accuracy, another to near-perfect.
  for (let i = 0; i < 40; i++) {
    recordMastery('arith.percents', false, 3)
    recordMastery('arith.ratios', true, 3)
  }

  // A fresh session each draw, so the interleaving rule cannot skew the counts --
  // this is testing the weighting on its own.
  let weak = 0
  let strong = 0
  for (let i = 0; i < 400; i++) {
    const pick = chooseSubtopic(newSession('quant'), 'quant')
    if (pick === 'arith.percents') weak++
    if (pick === 'arith.ratios') strong++
  }

  assert.ok(weak > strong, `weak came up ${weak} times, strong ${strong}`)
})

// ------------------------------------------------------------------- keeping stocked

test('the mixed refill plan interleaves sections and stocks verbal deeper', () => {
  const plan = refillPlan('both', 4)
  const sectionOf = (r: { subtopic: string }) => requireSubtopic(r.subtopic).section

  // Alternating, so neither section waits behind the whole of the other.
  const first = plan.slice(0, 10).map(sectionOf)
  assert.ok(first.includes('quant') && first.includes('verbal'))

  // Verbal has half the subtopics but takes half the questions, so each of its
  // buckets is stocked proportionally deeper -- the totals should roughly match.
  const totals = { quant: 0, verbal: 0 }
  for (const r of plan) totals[sectionOf(r)] += 1
  const ratio = totals.verbal / totals.quant
  assert.ok(ratio > 0.8 && ratio < 1.25, `verbal/quant refill ratio was ${ratio.toFixed(2)}`)
})

test('a single-section refill plan only names that section', () => {
  for (const only of ['quant', 'verbal'] as const) {
    const plan = refillPlan(only, 2)
    assert.ok(plan.length > 0)
    for (const r of plan) assert.equal(requireSubtopic(r.subtopic).section, only)
    assert.equal(plan.length, subtopicsFor(only).length * 2)
  }
})
