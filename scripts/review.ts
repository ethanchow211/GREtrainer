/**
 * Read stored questions with your own eyes.
 *
 * The pass rate from `npm run smoke` is only worth as much as your spot-check of it.
 * Automated gates catch broken questions; they cannot tell you whether a question
 * feels like the GRE. That judgement is yours.
 *
 * Usage:
 *   npm run review              -- 5 verified questions
 *   npm run review -- 10        -- 10 of them
 *   npm run review -- 10 rejected
 */

import { listQuestions } from '../src/server/store.ts'
import { requireSubtopic, QC_OPTIONS } from '../src/content/taxonomy.ts'
import type {
  GeneratedChoice,
  GeneratedComparison,
  GeneratedNumeric,
  GeneratedReading,
  GeneratedSentenceEquivalence,
  GeneratedTextCompletion,
} from '../src/server/schemas.ts'

const limit = Number(process.argv[2] ?? '5')
const status = process.argv[3] ?? 'verified'
const LETTERS = 'ABCDEF'

/** Make LaTeX readable in a terminal. Not a renderer -- just less noise. */
function plain(text: string): string {
  return text
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^}]*)\}/g, 'sqrt($1)')
    .replace(/\\times/g, 'x')
    .replace(/\\cdot/g, '*')
    .replace(/\\le\b/g, '<=')
    .replace(/\\ge\b/g, '>=')
    .replace(/\\neq\b/g, '!=')
    .replace(/\\pi\b/g, 'pi')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/\$/g, '')
}

function wrap(text: string, width = 76, indent = ''): string {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (line === '') line = word
      else if ((line + ' ' + word).length <= width) line += ' ' + word
      else {
        out.push(indent + line)
        line = word
      }
    }
    out.push(indent + line)
  }
  return out.join('\n')
}

const questions = listQuestions(status, limit)

if (questions.length === 0) {
  console.log(`No questions with status "${status}". Run \`npm run smoke\` first.`)
} else {
  console.log(`${questions.length} ${status} question(s), newest first.\n`)
}

for (const [i, q] of questions.entries()) {
  const sub = requireSubtopic(q.subtopic)
  console.log('='.repeat(78))
  console.log(`${i + 1}. ${sub.group} / ${sub.label}   [${q.format}]   difficulty ${q.difficulty}`)
  console.log('='.repeat(78))

  const p = q.payload

  switch (q.format) {
    case 'mc':
    case 'ms': {
      const d = p as GeneratedChoice
      console.log(wrap(plain(d.stem)))
      console.log()
      d.options.forEach((o, j) => console.log(`  ${LETTERS[j]}. ${plain(o)}`))
      console.log(`\nAnswer: ${d.correctIndices.map((n) => LETTERS[n]).join(', ')}`)
      if (d.checkExpr) console.log(`Checked by evaluating: ${d.checkExpr}`)
      break
    }

    case 'ne': {
      const d = p as GeneratedNumeric
      console.log(wrap(plain(d.stem)))
      console.log(`\nAnswer: ${d.correctValue}`)
      console.log(`Checked by evaluating: ${d.checkExpr}`)
      break
    }

    case 'qc': {
      const d = p as GeneratedComparison
      if (d.stem.trim()) console.log(wrap(plain(d.stem)) + '\n')
      console.log(`  Quantity A: ${plain(d.quantityA)}`)
      console.log(`  Quantity B: ${plain(d.quantityB)}`)
      console.log()
      QC_OPTIONS.forEach((o, j) => console.log(`  ${LETTERS[j]}. ${o}`))
      console.log(`\nAnswer: ${d.relation}`)
      if (d.checkA || d.checkB) console.log(`Checked by evaluating: A=${d.checkA ?? '-'}  B=${d.checkB ?? '-'}`)
      break
    }

    case 'tc': {
      const d = p as GeneratedTextCompletion
      console.log(wrap(plain(d.stem)))
      d.blanks.forEach((b, j) => {
        console.log(`\n  Blank ${j + 1}:`)
        b.options.forEach((o, k) => console.log(`    ${LETTERS[k]}. ${o}`))
      })
      console.log(`\nAnswer: ${d.blanks.map((b) => LETTERS[b.correctIndex]).join('; ')}`)
      break
    }

    case 'se': {
      const d = p as GeneratedSentenceEquivalence
      console.log(wrap(plain(d.stem)))
      console.log()
      d.options.forEach((o, j) => console.log(`  ${LETTERS[j]}. ${o}`))
      console.log(`\nAnswer: ${d.correctIndices.map((n) => LETTERS[n]).join(' and ')}`)
      break
    }

    case 'rc': {
      const d = p as GeneratedReading
      console.log(wrap(plain(d.passage)))
      console.log()
      console.log(wrap(plain(d.stem)))
      console.log()
      d.options.forEach((o, j) => console.log(`  ${LETTERS[j]}. ${plain(o)}`))
      console.log(`\nAnswer: ${d.correctIndices.map((n) => LETTERS[n]).join(', ')}`)
      break
    }
  }

  console.log('\nExplanation:')
  console.log(wrap(plain(q.explanation), 74, '  '))

  if (q.rejectReason) {
    console.log('\nRejected because:')
    console.log(wrap(q.rejectReason, 74, '  '))
  }
  console.log()
}
