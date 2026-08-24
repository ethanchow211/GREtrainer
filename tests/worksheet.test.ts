import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the database somewhere disposable BEFORE anything imports it, so these
// tests never touch real study progress.
const scratch = mkdtempSync(join(tmpdir(), 'gre-worksheet-'))
process.env.GRE_DB_PATH = join(scratch, 'test.db')

const { db } = await import('../src/server/db.ts')
const { planWorksheet, renderWorksheetHtml, saveWorksheet, pendingWorksheet, blockLines } = await import(
  '../src/server/worksheet.ts'
)
const { newPaperSession, nextQuestion, noteServed } = await import('../src/server/select.ts')
const { subtopicsFor, requireSubtopic } = await import('../src/content/taxonomy.ts')

after(() => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* Windows sometimes still holds the file; the temp directory gets cleaned anyway. */
  }
})

// ------------------------------------------------------------------------ fixtures

/**
 * Fill the bank with plausible questions in every subtopic. Stems are padded to a
 * realistic length so the page-packing maths is exercised rather than trivially
 * fitting everything onto one sheet.
 */
function seedBank(perSubtopic = 6): void {
  let n = 0
  for (const section of ['quant', 'verbal'] as const) {
    for (const sub of subtopicsFor(section)) {
      for (let i = 0; i < perSubtopic; i++) {
        const format = sub.formats[i % sub.formats.length] as string
        const stem = `Question ${n} about ${sub.label}. `.repeat(4)
        const payload: Record<string, unknown> = {
          stem,
          explanation: 'because',
          difficulty: 3,
        }
        if (format === 'qc') {
          Object.assign(payload, { quantityA: '2x', quantityB: 'x + 4', relation: 'undetermined' })
        } else if (format === 'ne') {
          Object.assign(payload, { correctValue: 7, answerIsFraction: false, checkExpr: '7' })
        } else if (format === 'tc') {
          Object.assign(payload, { blanks: [{ options: ['alpha', 'beta', 'gamma'], correctIndex: 1 }] })
        } else if (format === 'rc') {
          Object.assign(payload, {
            passage: 'A passage about something. '.repeat(30),
            options: ['one', 'two', 'three', 'four'],
            correctIndices: [0],
          })
        } else {
          Object.assign(payload, {
            options: ['one', 'two', 'three', 'four', 'five', 'six'].slice(0, format === 'se' ? 6 : 5),
            correctIndices: format === 'se' ? [0, 1] : [0],
            correctValue: null,
            checkExpr: null,
          })
        }

        db.prepare(
          `INSERT INTO questions (id, section, subtopic, format, difficulty, payload, answer, explanation,
             status, model, created_at)
           VALUES (?, ?, ?, ?, 3, ?, '[]', 'because', 'verified', 'test', ?)`,
        ).run(`q${n}`, section, sub.id, format, JSON.stringify(payload), new Date(2026, 0, 1).toISOString())
        n++
      }
    }
  }
}

seedBank()

// ------------------------------------------------------------------------- planning

test('a worksheet fills the pages asked for and never spills past them', () => {
  for (const pages of [1, 4, 10]) {
    const plan = planWorksheet(pages)
    assert.ok(plan.items.length > 0, `${pages}-page sheet came out empty`)
    const highest = Math.max(...plan.items.map((i) => i.page))
    assert.ok(highest <= pages, `a ${pages}-page sheet used ${highest} pages`)
    assert.equal(plan.shortBy, 0, `a ${pages}-page sheet could not be filled from a stocked bank`)
  }
})

test('no page is packed beyond the line budget', () => {
  const plan = planWorksheet(10)
  const perPage = new Map<number, number>()
  for (const item of plan.items) {
    const lines = blockLines(item.question).content + item.work + 1
    perPage.set(item.page, (perPage.get(item.page) ?? 0) + lines)
  }
  for (const [page, lines] of perPage) {
    assert.ok(lines <= 41, `page ${page} was packed to ${lines} lines`)
  }
})

test('planning a worksheet marks nothing as seen', () => {
  const before = (
    db.prepare('SELECT COUNT(*) AS n FROM questions WHERE first_served_at IS NOT NULL').get() as { n: number }
  ).n
  planWorksheet(10)
  const after = (
    db.prepare('SELECT COUNT(*) AS n FROM questions WHERE first_served_at IS NOT NULL').get() as { n: number }
  ).n
  assert.equal(after, before, 'planning consumed questions that should still be unseen')
})

test('a worksheet never repeats a question', () => {
  const plan = planWorksheet(10)
  const ids = plan.items.map((i) => i.question.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('a worksheet is half quant and half verbal, like the sessions it stands in for', () => {
  const plan = planWorksheet(10)
  const counts = { quant: 0, verbal: 0 }
  for (const item of plan.items) counts[requireSubtopic(item.question.subtopic).section] += 1
  assert.ok(
    Math.abs(counts.quant - counts.verbal) <= 1,
    `sheet came out ${counts.quant} quant to ${counts.verbal} verbal`,
  )
})

// -------------------------------------------------------------------------- serving

test('a paper session serves the printed order exactly', () => {
  const plan = planWorksheet(6)
  const printed = plan.items.map((i) => i.question.id)

  const state = newPaperSession(printed)
  const served: string[] = []
  for (let i = 0; i < printed.length; i++) {
    const pick = nextQuestion(state)
    assert.equal(pick.kind, 'question')
    if (pick.kind !== 'question') return
    served.push(pick.question.id)
    noteServed(state, pick.question, pick.mode)
  }

  assert.deepEqual(served, printed)
})

test('once the sheet runs out the session goes back to choosing for itself', () => {
  const plan = planWorksheet(1)
  const printed = plan.items.map((i) => i.question.id)
  const state = newPaperSession(printed)

  for (let i = 0; i < printed.length; i++) {
    const pick = nextQuestion(state)
    if (pick.kind === 'question') noteServed(state, pick.question, pick.mode)
  }

  const extra = nextQuestion(state)
  assert.equal(extra.kind, 'question', 'the session should carry on past the end of the sheet')
  if (extra.kind === 'question') assert.ok(!printed.includes(extra.question.id))
})

test('a question that has vanished from the bank is skipped, not fatal', () => {
  const plan = planWorksheet(2)
  const printed = plan.items.map((i) => i.question.id)
  const state = newPaperSession(['does-not-exist', ...printed])

  const pick = nextQuestion(state)
  assert.equal(pick.kind, 'question')
  if (pick.kind === 'question') assert.equal(pick.question.id, printed[0])
})

// ------------------------------------------------------------------------ rendering

test('the rendered sheet has one page element per planned page', () => {
  const plan = planWorksheet(10)
  const html = renderWorksheetHtml(plan)
  const pages = html.match(/<div class="page">/g) ?? []
  assert.equal(pages.length, Math.max(...plan.items.map((i) => i.page)))
})

test('the sheet carries its own maths fonts, so it prints anywhere', () => {
  const html = renderWorksheetHtml(planWorksheet(1))
  assert.ok(html.includes('data:font/woff2;base64,'), 'fonts were not inlined')
  assert.ok(!/url\(fonts\//.test(html), 'a font is still referenced from node_modules')
})

test('question text is escaped rather than injected', () => {
  const plan = planWorksheet(1)
  const first = plan.items[0]
  assert.ok(first)
  ;(first.question.payload as { stem: string }).stem = '<script>bad()</script> & "quotes"'
  const html = renderWorksheetHtml(plan)
  assert.ok(!html.includes('<script>bad()'), 'raw markup reached the page')
  assert.ok(html.includes('&lt;script&gt;'))
})

// -------------------------------------------------------------------------- storage

test('a saved worksheet comes back as the pending one, in order', () => {
  db.exec('DELETE FROM worksheets')
  const plan = planWorksheet(3)
  saveWorksheet(plan, 'C:/somewhere/worksheet.html')

  const pending = pendingWorksheet()
  assert.ok(pending)
  assert.deepEqual(
    pending.questionIds,
    plan.items.map((i) => i.question.id),
  )
  assert.equal(pending.pages, 3)
  assert.equal(pending.finishedAt, null)
})
