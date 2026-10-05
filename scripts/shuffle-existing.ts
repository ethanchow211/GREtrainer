/**
 * One-off: shuffle the answer choices of verbal questions already in the bank.
 *
 * New questions are shuffled as they are written (src/server/generate.ts). This
 * fixes the ones written before that, which have the right answer piled up on A
 * and B.
 *
 * Only questions you have never seen are touched. A question you have answered has
 * your past answer stored by position and may have a coaching note that names
 * letters, so re-lettering it would make those wrong.
 *
 * A copy of the database is saved first, to data/gre.db.bak.pre-shuffle.
 *
 *   node scripts/shuffle-existing.ts            -- show what would change
 *   node scripts/shuffle-existing.ts --apply    -- make the change
 */
import { existsSync } from 'node:fs'
import { db } from '../src/server/db.ts'
import { config } from '../src/server/config.ts'
import { shuffleChoices, SHUFFLED_FORMATS } from '../src/server/shuffle.ts'
import type { Format } from '../src/content/taxonomy.ts'
import type { Generated } from '../src/server/schemas.ts'

const apply = process.argv.includes('--apply')

const rows = db
  .prepare(
    `SELECT id, format, payload FROM questions q
      WHERE status = 'verified'
        AND first_served_at IS NULL
        AND format IN (${SHUFFLED_FORMATS.map(() => '?').join(', ')})
        AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.question_id = q.id)
        AND NOT EXISTS (SELECT 1 FROM coaching c WHERE c.question_id = q.id)
        AND NOT EXISTS (SELECT 1 FROM review_schedule r WHERE r.question_id = q.id)`,
  )
  .all(...SHUFFLED_FORMATS) as Array<{ id: string; format: Format; payload: string }>

/** Same encoding as the `answer` column written by store.ts. */
function answerColumn(q: Generated): string {
  const d = q as { correctIndices?: number[]; blanks?: Array<{ correctIndex: number }> }
  if (d.blanks) return d.blanks.map((b) => b.correctIndex).join(',')
  return (d.correctIndices ?? []).join(',')
}

const updates: Array<{ id: string; payload: Generated }> = []
const skipped: Record<string, number> = {}
for (const row of rows) {
  const before = JSON.parse(row.payload) as Generated
  const after = shuffleChoices(row.format, before)
  if (after === before) {
    skipped[row.format] = (skipped[row.format] ?? 0) + 1
  } else {
    updates.push({ id: row.id, payload: after })
  }
}

console.log(`${rows.length} unseen verbal questions found.`)
console.log(`${updates.length} can be shuffled safely.`)
console.log(`Left in their original order (explanation letters not certain):`, skipped)

if (!apply) {
  console.log('\nNothing changed. Run again with --apply to make the change.')
  process.exit(0)
}

const backup = `${config.dbPath}.bak.pre-shuffle`
if (existsSync(backup)) {
  console.error(`${backup} already exists. Move it aside first so the original is not overwritten.`)
  process.exit(1)
}
// VACUUM INTO writes a complete, consistent copy of the database to a new file.
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
console.log(`Backup written to ${backup}`)

const update = db.prepare('UPDATE questions SET payload = ?, answer = ?, explanation = ? WHERE id = ?')
db.exec('BEGIN')
try {
  for (const u of updates) {
    const explanation = (u.payload as { explanation: string }).explanation
    update.run(JSON.stringify(u.payload), answerColumn(u.payload), explanation, u.id)
  }
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}
console.log(`Shuffled ${updates.length} questions.`)
