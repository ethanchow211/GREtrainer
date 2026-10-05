import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeResponse } from '../src/server/coach.ts'

test('describes each fixed Quantitative Comparison choice in words', () => {
  assert.equal(
    describeResponse('qc', {}, { kind: 'choice', indices: [3] }),
    '"The relationship cannot be determined from the information given."',
  )
  assert.equal(
    describeResponse('qc', {}, { kind: 'choice', indices: [2] }),
    '"The two quantities are equal."',
  )
})

test('still describes generated answer options from the question payload', () => {
  assert.equal(
    describeResponse('mc', { options: ['first', 'second'] }, { kind: 'choice', indices: [1] }),
    '"second"',
  )
})
