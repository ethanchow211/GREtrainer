import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { ERROR_TAGS } from '../src/content/errors.ts'
import { SUBTOPICS, EXAM_SECTIONS } from '../src/content/taxonomy.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STRATEGY_DIR = join(ROOT, 'content', 'strategies')

function strategyFiles(): string[] {
  if (!existsSync(STRATEGY_DIR)) return []
  return readdirSync(STRATEGY_DIR).filter((f) => f.endsWith('.md'))
}

test('every strategy an error tag points at actually exists', () => {
  const present = new Set(strategyFiles().map((f) => f.replace(/\.md$/, '')))
  const missing: string[] = []

  for (const tag of ERROR_TAGS) {
    for (const s of tag.strategies) {
      if (!present.has(s)) missing.push(`${tag.id} -> "${s}"`)
    }
  }

  assert.deepEqual(missing, [], `error tags reference strategy pages that do not exist:\n${missing.join('\n')}`)
})

test('strategy pages link to each other without dead links', () => {
  const present = new Set(strategyFiles().map((f) => f.replace(/\.md$/, '')))
  const dead: string[] = []

  for (const file of strategyFiles()) {
    const text = readFileSync(join(STRATEGY_DIR, file), 'utf8')
    // Links are written as ordinary markdown with percent-encoded spaces, because
    // these are repo files rather than vault notes -- wikilinks would not resolve.
    for (const m of text.matchAll(/\]\(\.\/([^)]+)\.md\)/g)) {
      const target = decodeURIComponent(m[1] as string)
      if (!present.has(target)) dead.push(`${file} -> "${target}"`)
    }
  }

  assert.deepEqual(dead, [], `dead links between strategy pages:\n${dead.join('\n')}`)
})

test('every strategy page carries the frontmatter the app reads', () => {
  const problems: string[] = []

  for (const file of strategyFiles()) {
    const text = readFileSync(join(STRATEGY_DIR, file), 'utf8')
    if (!text.startsWith('---')) problems.push(`${file}: no frontmatter block`)
    if (!/^title:\s*\S/m.test(text)) problems.push(`${file}: no title`)
    if (!/^summary:\s*\S/m.test(text)) problems.push(`${file}: no summary (the app lists it)`)
    if (!/^tags:\s*\[/m.test(text)) problems.push(`${file}: no tags`)
    // Per house style the filename is the title, so the body starts at H2.
    if (/^# /m.test(text)) problems.push(`${file}: has an H1 in the body`)
  }

  assert.deepEqual(problems, [], problems.join('\n'))
})

test('subtopic ids are unique and every subtopic supports at least one format', () => {
  const seen = new Set<string>()
  for (const s of SUBTOPICS) {
    assert.equal(seen.has(s.id), false, `duplicate subtopic id: ${s.id}`)
    seen.add(s.id)
    assert.ok(s.formats.length > 0, `${s.id} has no answer formats`)
    assert.ok(s.note.length > 20, `${s.id} needs a real generator note`)
  }
})

test('quant and verbal formats do not leak into each other', () => {
  const verbalOnly = new Set(['tc', 'se', 'rc'])
  const quantOnly = new Set(['qc', 'ne'])

  for (const s of SUBTOPICS) {
    for (const f of s.formats) {
      if (s.section === 'quant') {
        assert.equal(verbalOnly.has(f), false, `${s.id} is quant but offers the verbal format ${f}`)
      } else {
        assert.equal(quantOnly.has(f), false, `${s.id} is verbal but offers the quant format ${f}`)
      }
    }
  }
})

test('the exam blueprint matches the published GRE structure', () => {
  // Verified against ETS. If ETS changes the test, this is the thing to update.
  const totalQuestions = EXAM_SECTIONS.reduce((n, s) => n + s.questions, 0)
  const totalMinutes = EXAM_SECTIONS.reduce((n, s) => n + s.minutes, 0)

  assert.equal(totalQuestions, 54, 'the two Verbal and two Quant sections total 54 questions')
  assert.equal(totalMinutes, 88, 'and 88 minutes, excluding the essay')

  const verbal = EXAM_SECTIONS.filter((s) => s.section === 'verbal')
  const quant = EXAM_SECTIONS.filter((s) => s.section === 'quant')
  assert.deepEqual(
    verbal.map((s) => [s.questions, s.minutes]),
    [
      [12, 18],
      [15, 23],
    ],
  )
  assert.deepEqual(
    quant.map((s) => [s.questions, s.minutes]),
    [
      [12, 21],
      [15, 26],
    ],
  )
})
