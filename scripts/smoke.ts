/**
 * Phase 1 quality gate.
 *
 * Generates a spread of questions, runs every verification gate, and reports how
 * many survived and why the rest did not. Nothing else in this project is worth
 * building until this number is good, because a study tool that teaches wrong
 * answers is worse than no study tool.
 *
 * Usage:
 *   npm run smoke              -- the default spread
 *   npm run smoke -- 2         -- 2 questions per bucket
 *   npm run smoke -- 1 quant   -- quant only
 */

import { generateQuestion } from '../src/server/generate.ts'
import { verifyQuestion } from '../src/server/verify.ts'
import { saveQuestion, recentStems, countByStatus } from '../src/server/store.ts'
import { budget, db } from '../src/server/db.ts'
import { detectBillingOverrides } from '../src/server/claude.ts'
import { resolveClaudeCli } from '../src/server/resolve-cli.ts'
import { config } from '../src/server/config.ts'
import { requireSubtopic, type Difficulty, type Format } from '../src/content/taxonomy.ts'

type Bucket = { subtopic: string; format: Format; difficulty: Difficulty }

/** A deliberate spread: every answer format, both sections, easy through hard. */
const SPREAD: Bucket[] = [
  { subtopic: 'arith.percents', format: 'mc', difficulty: 3 },
  { subtopic: 'alg.quadratic', format: 'mc', difficulty: 4 },
  { subtopic: 'arith.numberprops', format: 'qc', difficulty: 4 },
  { subtopic: 'geo.triangles', format: 'qc', difficulty: 3 },
  { subtopic: 'alg.wordproblems', format: 'ne', difficulty: 3 },
  { subtopic: 'data.stats', format: 'ne', difficulty: 4 },
  { subtopic: 'data.probability', format: 'mc', difficulty: 4 },
  { subtopic: 'alg.inequalities', format: 'ms', difficulty: 4 },
  { subtopic: 'tc.one', format: 'tc', difficulty: 3 },
  { subtopic: 'tc.two', format: 'tc', difficulty: 4 },
  { subtopic: 'tc.three', format: 'tc', difficulty: 5 },
  { subtopic: 'se.equivalence', format: 'se', difficulty: 3 },
  { subtopic: 'se.equivalence', format: 'se', difficulty: 4 },
  { subtopic: 'rc.inference', format: 'rc', difficulty: 4 },
  { subtopic: 'rc.mainidea', format: 'rc', difficulty: 3 },
  { subtopic: 'rc.argument', format: 'rc', difficulty: 4 },
]

const perBucket = Number(process.argv[2] ?? '1')
const sectionFilter = process.argv[3]

const buckets = SPREAD.filter((b) => !sectionFilter || requireSubtopic(b.subtopic).section === sectionFilter).flatMap(
  (b) => Array.from({ length: perBucket }, () => b),
)

type Outcome = {
  bucket: Bucket
  status: 'verified' | 'rejected' | 'error'
  reason?: string
  seconds: number
}

function bar(label: string): void {
  console.log(`\n${'-'.repeat(72)}\n${label}\n${'-'.repeat(72)}`)
}

async function main(): Promise<void> {
  bar('Setup')
  console.log(`claude binary : ${resolveClaudeCli().foundAt}`)
  console.log(`model         : ${config.model}`)
  console.log(`database      : ${config.dbPath}`)

  const overrides = detectBillingOverrides()
  if (overrides.length > 0) {
    console.log(
      `\n  NOTE: ${overrides.join(', ')} is set in your environment. It is stripped from\n` +
        '  every Claude call, so these questions still bill to your subscription rather\n' +
        '  than to a pay-per-token account.',
    )
  } else {
    console.log('billing       : subscription (no API-key variables in the environment)')
  }

  const startBudget = budget()
  console.log(`daily budget  : ${startBudget.used}/${startBudget.limit} calls used`)
  console.log(`\ngenerating ${buckets.length} questions (about 2 Claude calls each)...`)

  const outcomes: Outcome[] = []

  for (const [i, bucket] of buckets.entries()) {
    const sub = requireSubtopic(bucket.subtopic)
    const started = Date.now()
    process.stdout.write(
      `[${String(i + 1).padStart(2)}/${buckets.length}] ${bucket.format.toUpperCase().padEnd(3)} ${sub.label.padEnd(34)}`,
    )

    const gen = await generateQuestion({
      subtopicId: bucket.subtopic,
      format: bucket.format,
      difficulty: bucket.difficulty,
      avoid: recentStems(bucket.subtopic, bucket.format),
    })

    if (!gen.ok) {
      const seconds = (Date.now() - started) / 1000
      console.log(`ERROR   ${gen.error.slice(0, 80)}`)
      outcomes.push({ bucket, status: 'error', reason: gen.error, seconds })
      if (gen.error.includes('daily Claude call limit')) break
      continue
    }

    const verdict = await verifyQuestion(bucket.format, gen.data)
    saveQuestion({
      section: sub.section,
      subtopic: bucket.subtopic,
      format: bucket.format,
      question: gen.data,
      verdict,
      model: config.model,
    })

    const seconds = (Date.now() - started) / 1000
    console.log(
      verdict.status === 'verified'
        ? `PASS    ${seconds.toFixed(1)}s`
        : `REJECT  ${seconds.toFixed(1)}s  ${(verdict.reason ?? '').slice(0, 90)}`,
    )
    outcomes.push({ bucket, status: verdict.status, reason: verdict.reason, seconds })
  }

  // ------------------------------------------------------------------- reporting
  bar('Result')

  const verified = outcomes.filter((o) => o.status === 'verified').length
  const rejected = outcomes.filter((o) => o.status === 'rejected').length
  const errored = outcomes.filter((o) => o.status === 'error').length
  const total = outcomes.length
  const passRate = total > 0 ? (verified / total) * 100 : 0

  console.log(`passed   : ${verified}/${total}  (${passRate.toFixed(0)}%)`)
  console.log(`rejected : ${rejected}`)
  if (errored > 0) console.log(`errored  : ${errored}`)

  const byFormat = new Map<string, { pass: number; total: number }>()
  for (const o of outcomes) {
    const e = byFormat.get(o.bucket.format) ?? { pass: 0, total: 0 }
    e.total++
    if (o.status === 'verified') e.pass++
    byFormat.set(o.bucket.format, e)
  }
  console.log('\nby format:')
  for (const [format, e] of [...byFormat.entries()].sort()) {
    console.log(`  ${format.padEnd(4)} ${String(e.pass).padStart(2)}/${e.total}`)
  }

  const rejections = outcomes.filter((o) => o.status !== 'verified')
  if (rejections.length > 0) {
    console.log('\nwhy questions were rejected:')
    for (const r of rejections) {
      console.log(`  [${r.bucket.format}] ${requireSubtopic(r.bucket.subtopic).label}`)
      console.log(`      ${(r.reason ?? '').slice(0, 400)}`)
    }
  }

  const avg = total > 0 ? outcomes.reduce((s, o) => s + o.seconds, 0) / total : 0
  console.log(`\naverage time per question (generate + verify): ${avg.toFixed(1)}s`)

  const spent = db
    .prepare(
      'SELECT COUNT(*) AS calls, SUM(cost_usd) AS cost, SUM(input_tokens) AS inp, SUM(cache_tokens) AS cached, SUM(output_tokens) AS outp FROM call_log WHERE created_at >= ?',
    )
    .get(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()) as {
    calls: number
    cost: number | null
    inp: number | null
    cached: number | null
    outp: number | null
  }

  console.log(`\nClaude calls this run : ${spent.calls}`)
  // Most of the input arrives as cached prompt tokens, so counting only
  // input_tokens makes the prompts look far smaller than they are.
  console.log(`tokens in / out       : ${(spent.inp ?? 0) + (spent.cached ?? 0)} / ${spent.outp ?? 0}`)
  console.log(
    `notional API cost     : $${(spent.cost ?? 0).toFixed(3)}  (what this WOULD have cost on pay-per-token;\n` +
      '                        you were not charged this -- it is a gauge of subscription usage)',
  )

  const end = budget()
  console.log(`daily budget          : ${end.used}/${end.limit} calls used`)
  console.log(`\nquestions in database : ${JSON.stringify(countByStatus())}`)

  bar('Verdict')
  if (total === 0) {
    console.log('Nothing ran.')
  } else if (passRate >= 80) {
    console.log(`${passRate.toFixed(0)}% passed. That clears the Phase 1 bar of 80%.`)
    console.log('Next: read a few of the passing questions yourself before trusting the number.')
    console.log('  npm run review')
  } else {
    console.log(`${passRate.toFixed(0)}% passed, below the Phase 1 bar of 80%.`)
    console.log('Read the rejection reasons above -- they say whether the fault is in the')
    console.log('generator prompts, the verification gates, or genuinely bad questions.')
  }
}

await main()
