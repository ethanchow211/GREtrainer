/**
 * Move your questions and progress between machines.
 *
 * The database is one binary file, which git cannot merge -- two machines editing it
 * produce a conflict nobody can resolve by hand. So instead of committing the
 * database, we dump it to plain JSON that merges cleanly, and rebuild the database
 * from that on the other side.
 *
 *   npm run snapshot   -- database  -> data/snapshot/*.json   (commit these)
 *   npm run restore    -- JSON      -> database               (merges, never wipes)
 *
 * Restore merges rather than replaces: rows already present are left alone, so
 * running it cannot destroy progress made on this machine.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { db, nowIso } from '../src/server/db.ts'
import { ROOT } from '../src/server/config.ts'

const DIR = join(ROOT, 'data', 'snapshot')

/** Tables worth carrying between machines, with the column that identifies a row. */
const TABLES: Array<{ name: string; key: string | null }> = [
  { name: 'questions', key: 'id' },
  { name: 'attempts', key: null }, // append-only history; identified by content
  { name: 'mastery', key: 'subtopic' },
  { name: 'review_schedule', key: 'question_id' },
  { name: 'vocab', key: 'word' },
  { name: 'coaching', key: null },
]

function snapshot(): void {
  mkdirSync(DIR, { recursive: true })
  let total = 0

  for (const { name } of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${name}`).all()
    // Sorted output so two machines produce comparable files and git diffs stay small.
    const sorted = [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    writeFileSync(join(DIR, `${name}.json`), JSON.stringify(sorted, null, 1) + '\n', 'utf8')
    console.log(`  ${name.padEnd(16)} ${rows.length} rows`)
    total += rows.length
  }

  writeFileSync(
    join(DIR, 'meta.json'),
    JSON.stringify({ takenAt: nowIso(), rows: total }, null, 1) + '\n',
    'utf8',
  )
  console.log(`\nWrote ${total} rows to data/snapshot/. Commit that folder to carry progress across.`)
}

function restore(): void {
  if (!existsSync(DIR) || readdirSync(DIR).length === 0) {
    console.log('No snapshot found at data/snapshot/. Nothing to restore.')
    return
  }

  let inserted = 0
  let skipped = 0

  for (const { name, key } of TABLES) {
    const file = join(DIR, `${name}.json`)
    if (!existsSync(file)) continue

    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    if (rows.length === 0) continue

    const columns = Object.keys(rows[0] as Record<string, unknown>)
    const placeholders = columns.map(() => '?').join(', ')

    // "OR IGNORE" makes this a merge: an existing row wins, so restoring can never
    // overwrite work done on this machine.
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO ${name} (${columns.join(', ')}) VALUES (${placeholders})`,
    )

    const exists = key ? db.prepare(`SELECT 1 FROM ${name} WHERE ${key} = ?`) : null

    for (const row of rows) {
      if (exists && exists.get(row[key as string] as string | number)) {
        skipped++
        continue
      }
      try {
        // "OR IGNORE" skips silently, so the return value is the only way to know
        // whether a row was actually written. Counting calls instead of changes
        // would report work that never happened.
        const { changes } = stmt.run(
          ...(columns.map((c) => row[c] ?? null) as Array<string | number | null>),
        )
        if (Number(changes) > 0) inserted++
        else skipped++
      } catch {
        // A row that violates a constraint (usually a question the attempt refers to
        // being absent) is skipped rather than aborting the whole restore.
        skipped++
      }
    }
    console.log(`  ${name.padEnd(16)} processed ${rows.length} rows`)
  }

  console.log(`\nRestored ${inserted} new rows. ${skipped} already present or not applicable.`)
}

const mode = process.argv[2]
if (mode === 'restore') {
  console.log('Restoring from data/snapshot/ (merging, nothing is deleted)\n')
  restore()
} else {
  console.log('Snapshotting the database to data/snapshot/\n')
  snapshot()
}
