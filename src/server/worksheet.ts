import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import katex from 'katex'
import { db, nowIso } from './db.ts'
import { ROOT } from './config.ts'
import { newSession, nextQuestion, notePicked, takeById } from './select.ts'
import { splitMath } from '../ui/math-split.ts'
import { requireSubtopic, QC_OPTIONS } from '../content/taxonomy.ts'
import type { StoredQuestion } from './store.ts'
import type {
  GeneratedChoice,
  GeneratedComparison,
  GeneratedReading,
  GeneratedSentenceEquivalence,
  GeneratedTextCompletion,
} from './schemas.ts'

/**
 * Printable practice sheets.
 *
 * The point is to work problems on paper and still record every answer on screen,
 * which only works if the paper and the screen agree on what question 7 is. They
 * cannot agree by accident: subtopic choice is weighted-random, so running the
 * selection engine twice gives two different sheets.
 *
 * So the order is decided exactly once, here, by running the real selection engine
 * forward without letting it mark anything as seen. The resulting list of ids is
 * stored, the paper is rendered from it, and the app is told to serve that list.
 *
 * Nothing about how a question gets chosen changes -- this is the same weakness
 * weighting, interleaving, even quant/verbal split and difficulty targeting the
 * screen would have used. It is only frozen earlier.
 */

// ---------------------------------------------------------------------- page model
//
// Everything below is measured in lines of body text. Letter paper with 0.55in
// margins leaves about 9.9in of height, and 11pt text on 1.45 line spacing puts a
// line at roughly 0.22in, so a page holds about 45. Deliberately underestimated:
// spilling onto an eleventh page is worse than a little white space on the tenth.

// A page holds about 45 lines. The running header at the top of each one costs
// roughly two of them, and leaving that out of the budget put the tallest page at
// 9.83in against a 9.90in limit -- close enough that a substituted font would have
// spilled it onto an eleventh page.
const LINES_PER_PAGE = 41
const LINE_HEIGHT_IN = 0.22

/** Characters that fit on one line at 11pt across a 7.4in column. */
const CHARS_PER_LINE = 92
const OPTION_CHARS_PER_LINE = 84

/**
 * Work space is allocated in two passes, because a fixed allowance per question
 * wastes most of the paper. Fixing it at what a quant problem deserves meant one
 * question per page and a third of every page left blank at the bottom.
 *
 * So: pack pages using MIN_WORK, which is the least that is still usable, then hand
 * whatever is left on each page back to the questions on it, split by WEIGHT. A
 * quant problem gets three times the share of a sentence equivalence one, because
 * the work there is scratch algebra rather than re-reading a sentence.
 */
const MIN_WORK: Record<string, number> = { mc: 6, ms: 6, ne: 6, qc: 5, tc: 2, se: 2, rc: 2 }
const WEIGHT: Record<string, number> = { mc: 3, ms: 3, ne: 3, qc: 3, tc: 1, se: 1, rc: 1 }

/**
 * Past this there is more blank paper than anyone uses; the rest stays white space.
 * Verbal gets a lower cap than quant but not a tiny one -- a reading passage is
 * usually the only thing that fits on its page, and the room under it is worth
 * having for notes even though nothing is being calculated.
 */
const MAX_WORK: Record<string, number> = { mc: 20, ms: 20, ne: 20, qc: 18, tc: 12, se: 12, rc: 14 }

function textLines(text: string, width = CHARS_PER_LINE): number {
  // Hard line breaks count too: a passage with paragraph breaks is taller than its
  // character count alone suggests.
  return text
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0)
}

/** Height of the printed question itself, excluding the space left to work in. */
export function contentLines(q: StoredQuestion): number {
  const p = q.payload as Record<string, unknown>
  let n = 2 // the numbered heading and the rule under it

  if (typeof p.passage === 'string') n += textLines(p.passage) + 1
  if (typeof p.stem === 'string' && p.stem !== '') n += textLines(p.stem) + 1

  switch (q.format) {
    case 'qc': {
      const d = q.payload as GeneratedComparison
      n += textLines(d.quantityA, 40) + textLines(d.quantityB, 40) + 3
      n += QC_OPTIONS.length
      break
    }
    case 'tc': {
      const d = q.payload as GeneratedTextCompletion
      // Blanks sit side by side, so the tallest column sets the height.
      const perBlank = d.blanks.map(
        (b) => 1 + b.options.reduce((a, o) => a + Math.max(1, Math.ceil(o.length / 40)), 0),
      )
      n += Math.max(...perBlank, 1)
      break
    }
    case 'ne': {
      n += 2 // the answer box
      break
    }
    default: {
      const options = (p.options as string[] | undefined) ?? []
      n += options.reduce((a, o) => a + Math.max(1, Math.ceil(o.length / OPTION_CHARS_PER_LINE)), 0)
      break
    }
  }

  return n
}

/** The height a question needs to be allowed onto a page at all. */
export function blockLines(q: StoredQuestion): { content: number; work: number; total: number } {
  const content = contentLines(q)
  // A question taller than a page keeps only a token strip of work space rather
  // than pushing itself onto a second page.
  const work = Math.max(1, Math.min(MIN_WORK[q.format] ?? 4, LINES_PER_PAGE - content - 1))
  return { content, work, total: content + work + 1 }
}

/**
 * Share out the space left at the bottom of each page among the questions on it.
 * Called once packing is settled, so it can never change which page anything is on.
 */
function grantLeftoverSpace(items: PlannedQuestion[]): void {
  const byPage = new Map<number, PlannedQuestion[]>()
  for (const item of items) {
    const list = byPage.get(item.page) ?? []
    list.push(item)
    byPage.set(item.page, list)
  }

  for (const group of byPage.values()) {
    const used = group.reduce((n, i) => n + blockLines(i.question).total, 0)
    let spare = LINES_PER_PAGE - used
    if (spare <= 0) continue

    const totalWeight = group.reduce((n, i) => n + (WEIGHT[i.question.format] ?? 1), 0)
    for (const item of group) {
      const share = Math.floor((spare * (WEIGHT[item.question.format] ?? 1)) / totalWeight)
      const cap = MAX_WORK[item.question.format] ?? 10
      const grant = Math.max(0, Math.min(share, cap - item.work))
      item.work += grant
    }
    // Anything still going spare from a capped question goes to the first taker
    // that has room, so a page with one short question is not mostly white.
    spare = LINES_PER_PAGE - group.reduce((n, i) => n + blockLines(i.question).content + i.work + 1, 0)
    for (const item of group) {
      if (spare <= 0) break
      const cap = MAX_WORK[item.question.format] ?? 10
      const grant = Math.max(0, Math.min(spare, cap - item.work))
      item.work += grant
      spare -= grant
    }
  }
}

// -------------------------------------------------------------------- planning

export type PlannedQuestion = { question: StoredQuestion; page: number; work: number }

export type WorksheetPlan = {
  id: string
  pages: number
  items: PlannedQuestion[]
  /** Pages that could not be filled because the question pool ran dry. */
  shortBy: number
}

/** Pack already-chosen questions onto pages, greedily, in the order given. */
function paginate(questions: StoredQuestion[], pages: number): { items: PlannedQuestion[]; lastPage: number } {
  const items: PlannedQuestion[] = []
  let page = 1
  let used = 0

  for (const q of questions) {
    const { work, total } = blockLines(q)
    if (used > 0 && used + total > LINES_PER_PAGE) {
      page += 1
      used = 0
    }
    if (page > pages) break
    items.push({ question: q, page, work })
    used += total
  }

  grantLeftoverSpace(items)
  return { items, lastPage: items.length === 0 ? 0 : (items[items.length - 1] as PlannedQuestion).page }
}

/**
 * Decide what goes on the sheet, filling `pages` pages.
 *
 * Questions come out of the live selection engine one at a time. Nothing is marked
 * as seen: the sheet is a prediction of what the app will serve, and it stays true
 * because the app is then handed the same list.
 */
export function planWorksheet(pages: number): WorksheetPlan {
  const state = newSession('both')
  const items: PlannedQuestion[] = []

  let page = 1
  let used = 0

  for (;;) {
    const pick = nextQuestion(state)
    if (pick.kind !== 'question') break // pool is dry; stop rather than spend quota

    const { work, total } = blockLines(pick.question)
    if (used > 0 && used + total > LINES_PER_PAGE) {
      page += 1
      used = 0
    }
    if (page > pages) break // this one would start an extra page

    items.push({ question: pick.question, page, work })
    used += total
    notePicked(state, pick.question, pick.mode)
  }

  grantLeftoverSpace(items)
  const filled = items.length === 0 ? 0 : (items[items.length - 1] as PlannedQuestion).page
  return { id: randomUUID(), pages, items, shortBy: pages - filled }
}

// ---------------------------------------------------------------------- storage

export type StoredWorksheet = {
  id: string
  createdAt: string
  pages: number
  questionIds: string[]
  htmlPath: string | null
  finishedAt: string | null
}

export function saveWorksheet(plan: WorksheetPlan, htmlPath: string): void {
  db.prepare(
    'INSERT INTO worksheets (id, created_at, pages, question_ids, html_path) VALUES (?, ?, ?, ?, ?)',
  ).run(plan.id, nowIso(), plan.pages, JSON.stringify(plan.items.map((i) => i.question.id)), htmlPath)
}

type WorksheetRow = {
  id: string
  created_at: string
  pages: number
  question_ids: string
  html_path: string | null
  finished_at: string | null
}

function hydrateWorksheet(r: WorksheetRow): StoredWorksheet {
  return {
    id: r.id,
    createdAt: r.created_at,
    pages: r.pages,
    questionIds: JSON.parse(r.question_ids) as string[],
    htmlPath: r.html_path,
    finishedAt: r.finished_at,
  }
}

export function getWorksheet(id: string): StoredWorksheet | null {
  const row = db.prepare('SELECT * FROM worksheets WHERE id = ?').get(id) as WorksheetRow | undefined
  return row ? hydrateWorksheet(row) : null
}

/** The most recent sheet that has not been worked through yet. */
export function pendingWorksheet(): StoredWorksheet | null {
  const row = db
    .prepare('SELECT * FROM worksheets WHERE finished_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get() as WorksheetRow | undefined
  return row ? hydrateWorksheet(row) : null
}

export function finishWorksheet(id: string): void {
  db.prepare('UPDATE worksheets SET finished_at = ? WHERE id = ? AND finished_at IS NULL').run(nowIso(), id)
}

/**
 * How much of a sheet has been answered. Counted from the attempts table rather
 * than from session state, so closing the browser part-way through does not lose it.
 */
export function worksheetProgress(sheet: StoredWorksheet): { answered: number; total: number } {
  if (sheet.questionIds.length === 0) return { answered: 0, total: 0 }
  const placeholders = sheet.questionIds.map(() => '?').join(',')
  const row = db
    .prepare(`SELECT COUNT(DISTINCT question_id) AS n FROM attempts WHERE question_id IN (${placeholders})`)
    .get(...sheet.questionIds) as { n: number }
  return { answered: row.n, total: sheet.questionIds.length }
}

/** Rebuild a plan from stored ids, for reprinting a sheet without re-choosing it. */
export function rehydratePlan(sheet: StoredWorksheet): WorksheetPlan {
  const questions = sheet.questionIds.map((id) => takeById(id)).filter((q): q is StoredQuestion => q !== null)
  const { items } = paginate(questions, sheet.pages)
  return { id: sheet.id, pages: sheet.pages, items, shortBy: 0 }
}

// --------------------------------------------------------------------- rendering

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Prose with LaTeX in it, rendered to HTML. Uses the same splitter the screen uses,
 * so a question that renders correctly in the app renders correctly on paper.
 */
export function renderText(source: string): string {
  return splitMath(source)
    .map((seg) => {
      if (seg.kind === 'text') return escapeHtml(seg.text).replace(/\n/g, '<br>')
      try {
        return katex.renderToString(seg.tex, {
          displayMode: seg.kind === 'display',
          throwOnError: false,
          output: 'html',
        })
      } catch {
        return escapeHtml(seg.kind === 'display' ? `$$${seg.tex}$$` : `$${seg.tex}$`)
      }
    })
    .join('')
}

const LETTERS = 'ABCDEFGH'

function renderOptions(options: string[], style: 'circle' | 'square'): string {
  const rows = options
    .map(
      (o, i) =>
        `<li class="opt"><span class="mark ${style}">${LETTERS[i]}</span>` +
        `<span class="opt-text">${renderText(o)}</span></li>`,
    )
    .join('')
  return `<ul class="opts">${rows}</ul>`
}

function renderBody(q: StoredQuestion): string {
  const p = q.payload as Record<string, unknown>
  const parts: string[] = []

  if (typeof p.passage === 'string') {
    parts.push(`<div class="passage">${renderText(p.passage)}</div>`)
  }
  if (typeof p.stem === 'string' && p.stem !== '') {
    parts.push(`<div class="stem">${renderText(p.stem)}</div>`)
  }

  switch (q.format) {
    case 'qc': {
      const d = q.payload as GeneratedComparison
      parts.push(
        `<table class="qc"><tr>` +
          `<td><div class="qc-label">Quantity A</div><div class="qc-value">${renderText(d.quantityA)}</div></td>` +
          `<td><div class="qc-label">Quantity B</div><div class="qc-value">${renderText(d.quantityB)}</div></td>` +
          `</tr></table>`,
      )
      parts.push(renderOptions([...QC_OPTIONS], 'circle'))
      break
    }
    case 'tc': {
      const d = q.payload as GeneratedTextCompletion
      const columns = d.blanks
        .map(
          (b, i) =>
            `<div class="blank"><div class="blank-label">Blank (${i + 1})</div>` +
            `${renderOptions(b.options, 'circle')}</div>`,
        )
        .join('')
      parts.push(`<div class="blanks">${columns}</div>`)
      break
    }
    case 'se': {
      const d = q.payload as GeneratedSentenceEquivalence
      parts.push(`<div class="hint">Choose exactly two.</div>`)
      parts.push(renderOptions(d.options, 'square'))
      break
    }
    case 'ms': {
      const d = q.payload as GeneratedChoice
      parts.push(`<div class="hint">Choose all that apply.</div>`)
      parts.push(renderOptions(d.options, 'square'))
      break
    }
    case 'ne': {
      parts.push(`<div class="numeric"><span>Answer</span><span class="box"></span></div>`)
      break
    }
    default: {
      const d = q.payload as GeneratedChoice | GeneratedReading
      const many = d.correctIndices.length > 1
      if (many) parts.push(`<div class="hint">Choose all that apply.</div>`)
      parts.push(renderOptions(d.options, many ? 'square' : 'circle'))
      break
    }
  }

  return parts.join('\n')
}

const FORMAT_NAMES: Record<string, string> = {
  mc: 'Multiple choice',
  ms: 'Multiple select',
  ne: 'Numeric entry',
  qc: 'Quantitative comparison',
  tc: 'Text completion',
  se: 'Sentence equivalence',
  rc: 'Reading comprehension',
}

/**
 * KaTeX's stylesheet with its web fonts inlined as data URIs.
 *
 * The alternative is linking to node_modules, which breaks the moment the file is
 * moved or emailed -- and a maths worksheet whose symbols silently fall back to a
 * serif face is worse than useless. Only the woff2 faces are kept; every browser
 * that can print this reads woff2, and dropping woff and ttf cuts the size by two
 * thirds.
 */
function katexCss(): string {
  const dist = join(ROOT, 'node_modules', 'katex', 'dist')
  const css = readFileSync(join(dist, 'katex.min.css'), 'utf8')

  const fonts = new Map<string, string>()
  for (const file of readdirSync(join(dist, 'fonts'))) {
    if (file.endsWith('.woff2')) {
      fonts.set(file, readFileSync(join(dist, 'fonts', file)).toString('base64'))
    }
  }

  // The stylesheet is minified, so a src declaration ends at either a semicolon or
  // the closing brace of its rule -- the terminator has to be put back, or every
  // @font-face block after the first is swallowed.
  return css.replace(/src:[^;}]+([;}])/g, (src, end: string) => {
    const match = /fonts\/([A-Za-z0-9_-]+\.woff2)/.exec(src)
    const data = match ? fonts.get(match[1] as string) : undefined
    if (!data) return src
    return `src:url(data:font/woff2;base64,${data}) format("woff2")${end}`
  })
}

const SHEET_CSS = `
@page { size: letter; margin: 0.55in; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  font: 11pt/1.45 Georgia, "Times New Roman", serif;
  color: #111;
  background: #fff;
}
.page { page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }

.sheet-head {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 2px solid #111; padding-bottom: 4pt; margin-bottom: 12pt;
}
.sheet-head .title { font-size: 12pt; font-weight: bold; letter-spacing: .02em; }
.sheet-head .meta { font-size: 8.5pt; color: #555; font-family: system-ui, sans-serif; }

.q { margin-bottom: 13pt; break-inside: avoid; }
.q-head {
  display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1px solid #bbb; padding-bottom: 2pt; margin-bottom: 6pt;
}
.q-num { font-size: 11.5pt; font-weight: bold; font-family: system-ui, sans-serif; }
.q-tags { font-size: 8pt; color: #666; font-family: system-ui, sans-serif; letter-spacing: .03em; }

.passage {
  margin: 0 0 8pt; padding: 6pt 9pt; background: #f4f4f2;
  border-left: 2.5pt solid #999; font-size: 10.5pt; text-align: justify;
}
.stem { margin: 0 0 7pt; }
.hint { font-size: 9pt; font-style: italic; color: #555; margin: 0 0 4pt; }

.opts { list-style: none; margin: 0; padding: 0; }
.opt { display: flex; align-items: flex-start; gap: 7pt; margin: 0 0 3pt; }
.mark {
  flex: none; width: 15pt; height: 15pt; line-height: 13pt; text-align: center;
  font-size: 8.5pt; font-family: system-ui, sans-serif; color: #444; border: 1pt solid #666;
}
.mark.circle { border-radius: 50%; }
.mark.square { border-radius: 2pt; }
.opt-text { flex: 1; }

.qc { width: 100%; margin: 0 0 8pt; border-collapse: collapse; }
.qc td { width: 50%; border: 1pt solid #ccc; padding: 5pt 8pt; vertical-align: top; }
.qc-label {
  font-size: 8pt; font-family: system-ui, sans-serif; color: #666;
  text-transform: uppercase; letter-spacing: .06em; margin-bottom: 2pt;
}
.qc-value { font-size: 11pt; }

.blanks { display: flex; gap: 14pt; margin: 0 0 4pt; }
.blank { flex: 1; }
.blank-label {
  font-size: 8.5pt; font-family: system-ui, sans-serif; color: #666;
  text-transform: uppercase; letter-spacing: .05em; margin-bottom: 3pt;
}

.numeric {
  display: flex; align-items: center; gap: 8pt; margin: 2pt 0 0;
  font-family: system-ui, sans-serif; font-size: 9pt; color: #555;
}
.numeric .box { display: inline-block; width: 110pt; height: 22pt; border: 1pt solid #666; }

.work { border-top: 1px dashed #ccc; margin-top: 6pt; position: relative; }
.work::before {
  content: "work"; position: absolute; top: 2pt; left: 0;
  font-size: 7pt; font-family: system-ui, sans-serif; color: #bbb;
  text-transform: uppercase; letter-spacing: .1em;
}

.katex { font-size: 1.04em; }
.katex-display { margin: 6pt 0; }
`

export type RenderOptions = { title?: string; generatedAt?: string }

export function renderWorksheetHtml(plan: WorksheetPlan, options: RenderOptions = {}): string {
  const title = options.title ?? 'GRE Trainer worksheet'
  const stamp = options.generatedAt ?? nowIso().slice(0, 10)

  const byPage = new Map<number, PlannedQuestion[]>()
  for (const item of plan.items) {
    const list = byPage.get(item.page) ?? []
    list.push(item)
    byPage.set(item.page, list)
  }

  const totalPages = Math.max(...[...byPage.keys(), 1])
  let number = 0
  const pages: string[] = []

  for (let p = 1; p <= totalPages; p++) {
    const blocks = (byPage.get(p) ?? [])
      .map((item) => {
        number += 1
        const q = item.question
        const sub = requireSubtopic(q.subtopic)
        const measure = sub.section === 'quant' ? 'Quant' : 'Verbal'
        const tags = `${measure} · ${sub.label} · ${FORMAT_NAMES[q.format]} · difficulty ${q.difficulty}/5`
        return (
          `<section class="q">` +
          `<div class="q-head"><span class="q-num">${number}</span>` +
          `<span class="q-tags">${escapeHtml(tags)}</span></div>` +
          renderBody(q) +
          `<div class="work" style="height:${(item.work * LINE_HEIGHT_IN).toFixed(2)}in"></div>` +
          `</section>`
        )
      })
      .join('\n')

    pages.push(
      `<div class="page">` +
        `<div class="sheet-head"><span class="title">${escapeHtml(title)}</span>` +
        `<span class="meta">${escapeHtml(stamp)} · page ${p} of ${totalPages} · ` +
        `answer in the app in this order</span></div>` +
        blocks +
        `</div>`,
    )
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${katexCss()}</style>
<style>${SHEET_CSS}</style>
</head>
<body>
${pages.join('\n')}
</body>
</html>
`
}
