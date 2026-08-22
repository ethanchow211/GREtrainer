/**
 * Wipe your study history and start clean.
 *
 * Clears answers, topic estimates, and the review queue. **Keeps the question
 * bank**, which is the expensive part — every question stays, and all of them
 * become unseen again, so nothing you paid quota for is thrown away.
 *
 * The point of this is that practice runs, testing, or a half-finished session
 * should not permanently skew the estimates that decide what you get asked next.
 *
 *   npm run reset-progress          -- show what would be cleared, change nothing
 *   npm run reset-progress -- --yes -- actually do it
 */

import { copyFileSync, existsSync } from 'node:fs'
import { db } from '../src/server/db.ts'
import { config } from '../src/server/config.ts'

const confirmed = process.argv.includes('--yes')

const counts = {
  attempts: (db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n,
  mastery: (db.prepare('SELECT COUNT(*) AS n FROM mastery').get() as { n: number }).n,
  reviews: (db.prepare('SELECT COUNT(*) AS n FROM review_schedule').get() as { n: number }).n,
  served: (db.prepare('SELECT COUNT(*) AS n FROM questions WHERE first_served_at IS NOT NULL').get() as {
    n: number
  }).n,
  questions: (db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status = 'verified'").get() as {
    n: number
  }).n,
  vocab: (db.prepare('SELECT COUNT(*) AS n FROM vocab').get() as { n: number }).n,
}

console.log('Would clear:')
console.log(`  ${counts.attempts} answered questions`)
console.log(`  ${counts.mastery} topic estimates`)
console.log(`  ${counts.reviews} queued reviews`)
console.log(`  the "already seen" mark on ${counts.served} questions`)
console.log('\nWould keep:')
console.log(`  ${counts.questions} verified questions (all of them become unseen again)`)
console.log(`  ${counts.vocab} vocabulary words and their schedules`)
console.log('  the record of Claude calls, so today\'s budget stays honest')

if (!confirmed) {
  console.log('\nNothing was changed. Re-run with --yes to go ahead:')
  console.log('  npm run reset-progress -- --yes')
  process.exit(0)
}

// Back the database up first. This is the only destructive command in the project.
const backup = `${config.dbPath}.before-reset`
if (existsSync(config.dbPath)) {
  copyFileSync(config.dbPath, backup)
  console.log(`\nBacked the database up to ${backup}`)
}

db.exec(`
  DELETE FROM attempts;
  DELETE FROM mastery;
  DELETE FROM review_schedule;
  UPDATE questions SET first_served_at = NULL;
`)

console.log('Cleared. Your topic estimates start from nothing and every question is fresh again.')
