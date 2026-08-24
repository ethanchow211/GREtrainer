/**
 * Print a practice sheet.
 *
 * Picks questions with the same engine the app uses, freezes the order, writes a
 * printable HTML file, and records the order so the app serves exactly what is on
 * the paper. Work the problems by hand, then click the same answers in the app so
 * the timing, the mastery estimates and the review schedule all still get recorded.
 *
 *   npm run worksheet                 -- 10 pages
 *   npm run worksheet -- --pages 4    -- a shorter one
 *   npm run worksheet -- --answers    -- append an answer key
 *   npm run worksheet -- --reprint    -- re-render the pending sheet, same order
 *
 * No Claude calls are made and no quota is spent: this only draws on questions
 * already in the bank.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../src/server/config.ts'
import { readyCount } from '../src/server/buffer.ts'
import { requireSubtopic, QC_OPTIONS } from '../src/content/taxonomy.ts'
import {
  planWorksheet,
  rehydratePlan,
  renderWorksheetHtml,
  saveWorksheet,
  pendingWorksheet,
  type WorksheetPlan,
} from '../src/server/worksheet.ts'
import type { StoredQuestion } from '../src/server/store.ts'
import type {
  GeneratedChoice,
  GeneratedComparison,
  GeneratedNumeric,
  GeneratedReading,
  GeneratedSentenceEquivalence,
  GeneratedTextCompletion,
} from '../src/server/schemas.ts'

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function option(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = Number(process.argv[i + 1])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const pages = option('pages', 10)
const withAnswers = flag('answers')
const reprint = flag('reprint')

const LETTERS = 'ABCDEFGH'

/** The answer to one question, written the way it reads on paper. */
function answerText(q: StoredQuestion): string {
  switch (q.format) {
    case 'qc': {
      const d = q.payload as GeneratedComparison
      const index = { A: 0, B: 1, equal: 2, undetermined: 3 }[d.relation]
      return `${LETTERS[index]} — ${QC_OPTIONS[index]}`
    }
    case 'ne': {
      const d = q.payload as GeneratedNumeric
      return String(d.correctValue)
    }
    case 'tc': {
      const d = q.payload as GeneratedTextCompletion
      return d.blanks
        .map((b, i) => `(${i + 1}) ${LETTERS[b.correctIndex]} ${b.options[b.correctIndex]}`)
        .join('   ')
    }
    default: {
      const d = q.payload as GeneratedChoice | GeneratedReading | GeneratedSentenceEquivalence
      return d.correctIndices
        .map((i) => `${LETTERS[i]} ${String(d.options[i] ?? '').slice(0, 40)}`)
        .join('   ')
    }
  }
}

function answerKeyHtml(plan: WorksheetPlan): string {
  const rows = plan.items
    .map((item, i) => {
      const sub = requireSubtopic(item.question.subtopic)
      return (
        `<tr><td class="n">${i + 1}</td>` +
        `<td class="t">${sub.label}</td>` +
        `<td class="a">${answerText(item.question).replace(/[<>&]/g, '')}</td></tr>`
      )
    })
    .join('')

  return (
    `<div class="page"><div class="sheet-head"><span class="title">Answer key</span>` +
    `<span class="meta">check after you have logged them in the app, not before</span></div>` +
    `<table class="key">${rows}</table></div>` +
    `<style>.key{width:100%;border-collapse:collapse;font-size:9.5pt}` +
    `.key td{border-bottom:1px solid #ddd;padding:2.5pt 4pt;vertical-align:top}` +
    `.key .n{width:22pt;font-weight:bold;font-family:system-ui,sans-serif}` +
    `.key .t{width:130pt;color:#666;font-family:system-ui,sans-serif;font-size:8.5pt}</style>`
  )
}

// ------------------------------------------------------------------------- run

const existing = pendingWorksheet()

if (reprint) {
  if (!existing) {
    console.log('There is no unfinished worksheet to reprint. Run `npm run worksheet` to make one.')
    process.exit(1)
  }
  const plan = rehydratePlan(existing)
  const path = existing.htmlPath ?? join(ROOT, 'data', 'worksheet.html')
  let html = renderWorksheetHtml(plan, { generatedAt: existing.createdAt.slice(0, 10) })
  if (withAnswers) html = html.replace('</body>', `${answerKeyHtml(plan)}</body>`)
  writeFileSync(path, html, 'utf8')
  console.log(`Reprinted ${plan.items.length} questions to ${path}`)
  process.exit(0)
}

if (existing) {
  console.log('There is already an unfinished worksheet.')
  console.log(`  ${existing.questionIds.length} questions, made ${existing.createdAt.slice(0, 10)}`)
  console.log(`  ${existing.htmlPath ?? '(file missing)'}`)
  console.log('\nWork through it in the app first, or reprint the same one:')
  console.log('  npm run worksheet -- --reprint')
  console.log('\nMaking a new sheet now would replace it as the pending one. To do that anyway:')
  console.log('  npm run worksheet -- --force')
  if (!flag('force')) process.exit(1)
}

const ready = { quant: readyCount('quant'), verbal: readyCount('verbal') }
console.log(`Question bank: ${ready.quant} quant, ${ready.verbal} verbal unseen.`)

const plan = planWorksheet(pages)

if (plan.items.length === 0) {
  console.log('\nNo unseen questions left in the bank. Run the app for a while to build a pool.')
  process.exit(1)
}

const path = join(ROOT, 'data', 'worksheet.html')
let html = renderWorksheetHtml(plan)
if (withAnswers) html = html.replace('</body>', `${answerKeyHtml(plan)}</body>`)
writeFileSync(path, html, 'utf8')
saveWorksheet(plan, path)

const counts = { quant: 0, verbal: 0 }
for (const item of plan.items) counts[requireSubtopic(item.question.subtopic).section] += 1
const filled = plan.pages - plan.shortBy

console.log(`\n${plan.items.length} questions over ${filled} pages — ${counts.quant} quant, ${counts.verbal} verbal.`)
if (plan.shortBy > 0) {
  console.log(`Only ${filled} of the ${pages} pages could be filled; the bank ran out of unseen questions.`)
}
console.log(`\nWritten to ${path}`)
console.log('Open it in a browser and print (Ctrl+P). It is self-contained -- maths fonts are embedded.')
console.log('\nThen in the app, pick "Paper worksheet" on the start screen. It serves these same')
console.log('questions in this same order, so question 7 on paper is question 7 on screen.')
