import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Its own disposable database, so the answers recorded here cannot leak into the
// other selection tests (and never touch real study progress).
const scratch = mkdtempSync(join(tmpdir(), 'gre-mixed-'))
process.env.GRE_DB_PATH = join(scratch, 'test.db')

const { newSession, targetSection, quantShare } = await import('../src/server/select.ts')
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

/** Share of `draws` Mixed-session picks that came out as quant. */
function quantFraction(draws: number): number {
  const state = newSession('both')
  let quant = 0
  for (let i = 0; i < draws; i++) if (targetSection(state) === 'quant') quant++
  return quant / draws
}

test('with nothing answered, Mixed is an even split', () => {
  assert.equal(quantShare(), 0.5)
})

test('getting every maths question right makes Mixed mostly English', () => {
  // Thirty maths questions, all correct, spread over the quant subtopics.
  // English untouched.
  const quantTopics = subtopicsFor('quant')
  for (let i = 0; i < 30; i++) recordMastery(quantTopics[i % quantTopics.length]!.id, true, 3)

  const share = quantShare()
  assert.ok(share <= 0.25, `quant share after 30 right was ${share.toFixed(2)}`)

  // ...but maths still comes up: it is floored at 20%, never shut out.
  assert.ok(share >= 0.2 - 1e-9)
  const seen = quantFraction(2000)
  assert.ok(seen > 0.15 && seen < 0.3, `quant came up ${(seen * 100).toFixed(1)}% of the time`)

  // And the question-writer follows suit: most of what it plans to write is English.
  const plan = refillPlan('both', 5)
  const verbalPlanned = plan.filter((r) => requireSubtopic(r.subtopic).section === 'verbal').length
  assert.ok(verbalPlanned / plan.length > 0.65, `only ${verbalPlanned} of ${plan.length} planned were English`)
})

test('missing a run of maths swings it back toward maths', () => {
  // Before: maths perfect, English untouched, so maths is at the 20% floor.
  const before = quantShare()

  // Now miss forty maths questions in a row.
  const quantTopics = subtopicsFor('quant')
  for (let i = 0; i < 40; i++) recordMastery(quantTopics[i % quantTopics.length]!.id, false, 3)

  const after = quantShare()
  assert.ok(after > before + 0.2, `quant share went from ${before.toFixed(2)} to only ${after.toFixed(2)}`)
})
