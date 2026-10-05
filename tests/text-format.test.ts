import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderText } from '../src/ui/text-format.ts'

test('renders double-asterisk emphasis as bold text', () => {
  assert.equal(
    renderText('The **fossil correlations** were available all along.'),
    'The <strong>fossil correlations</strong> were available all along.',
  )
})

test('escapes model-supplied HTML inside and outside bold text', () => {
  assert.equal(
    renderText('<script> **A & B**'),
    '&lt;script&gt; <strong>A &amp; B</strong>',
  )
})

test('leaves unmatched and empty bold markers visible', () => {
  assert.equal(renderText('An **unfinished thought'), 'An **unfinished thought')
  assert.equal(renderText('Keep **** visible'), 'Keep **** visible')
})

test('preserves line breaks', () => {
  assert.equal(renderText('first\n**second**'), 'first<br /><strong>second</strong>')
})
