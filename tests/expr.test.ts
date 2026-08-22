import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, matchesAnswer } from '../src/server/expr.ts'

function val(src: string): number {
  const r = evaluate(src)
  assert.equal(r.ok, true, `expected ${src} to evaluate, got ${r.ok ? '' : r.error}`)
  return (r as { ok: true; value: number }).value
}

function fails(src: string): string {
  const r = evaluate(src)
  assert.equal(r.ok, false, `expected ${src} to fail, got ${r.ok ? r.value : ''}`)
  return (r as { ok: false; error: string }).error
}

test('basic arithmetic', () => {
  assert.equal(val('1+2'), 3)
  assert.equal(val('7-9'), -2)
  assert.equal(val('6*7'), 42)
  assert.equal(val('9/4'), 2.25)
  assert.equal(val('17 * 23'), 391)
})

test('precedence and parentheses', () => {
  assert.equal(val('2+3*4'), 14)
  assert.equal(val('(2+3)*4'), 20)
  assert.equal(val('(3*8-4)/5'), 4)
  assert.equal(val('10-2-3'), 5, 'subtraction is left associative')
  assert.equal(val('100/5/2'), 10, 'division is left associative')
})

test('exponents are right associative and bind tighter than unary minus', () => {
  assert.equal(val('2^3'), 8)
  assert.equal(val('2^3^2'), 512, '2^(3^2), not (2^3)^2')
  assert.equal(val('-2^2'), -4, 'reads as -(2^2), matching normal maths convention')
  assert.equal(val('2**5'), 32, '** accepted as a synonym for ^')
  assert.equal(val('2^-1'), 0.5)
})

test('unary signs', () => {
  assert.equal(val('-5'), -5)
  assert.equal(val('--5'), 5)
  assert.equal(val('3 * -4'), -12)
})

test('decimals', () => {
  assert.equal(val('0.5+0.25'), 0.75)
  assert.equal(val('.5*4'), 2)
})

test('functions', () => {
  assert.equal(val('sqrt(16)'), 4)
  assert.equal(val('abs(-7)'), 7)
  assert.equal(val('pow(3,4)'), 81)
  assert.equal(val('min(4,9,2)'), 2)
  assert.equal(val('max(4,9,2)'), 9)
  assert.equal(val('floor(7/2)'), 3)
  assert.equal(val('ceil(7/2)'), 4)
  assert.equal(val('round(2.5)'), 3)
  assert.ok(Math.abs(val('pi') - Math.PI) < 1e-12)
})

test('rejects division by zero rather than returning Infinity', () => {
  assert.match(fails('1/0'), /division by zero/)
  assert.match(fails('5/(3-3)'), /division by zero/)
})

test('rejects anything that is not arithmetic', () => {
  // The whole point of this module: model-written text must not be able to run code.
  fails('process.exit(1)')
  fails('require("fs")')
  fails('globalThis')
  fails('1; console.log(2)')
  fails('(() => 1)()')
  fails('x + 1')
  fails('1 + ')
  fails('(1+2')
  fails('1 2')
  fails('sqrt()')
  fails('pow(2)')
  fails('nope(3)')
  fails('')
  fails('   ')
})

test('rejects absurdly long input', () => {
  assert.match(fails('1+'.repeat(400) + '1'), /too long/)
})

test('matchesAnswer tolerates reasonable rounding', () => {
  assert.equal(matchesAnswer(1 / 3, 0.333), true, 'a third stated to three places')
  assert.equal(matchesAnswer(391, 391), true)
  assert.equal(matchesAnswer(0, 0), true)
  assert.equal(matchesAnswer(2.0000001, 2), true)

  assert.equal(matchesAnswer(391, 390), false, 'off by one is a real mismatch')
  assert.equal(matchesAnswer(1 / 3, 0.3), false)
  assert.equal(matchesAnswer(5, -5), false)
  assert.equal(matchesAnswer(Number.NaN, 5), false)
  assert.equal(matchesAnswer(Number.POSITIVE_INFINITY, 5), false)
})
