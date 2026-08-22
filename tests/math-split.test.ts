import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitMath, type MathSegment } from '../src/ui/math-split.ts'

/** Compact view of a split, for readable assertions. */
function shape(source: string): string {
  return splitMath(source)
    .map((s) => (s.kind === 'text' ? `T(${s.text})` : s.kind === 'inline' ? `I(${s.tex})` : `D(${s.tex})`))
    .join('')
}

function texts(source: string): string {
  return splitMath(source)
    .filter((s): s is Extract<MathSegment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.text)
    .join('')
}

test('plain prose is left alone', () => {
  assert.equal(shape('The critic was laconic.'), 'T(The critic was laconic.)')
})

test('inline maths is picked out', () => {
  assert.equal(shape('If $x = 4$ then done.'), 'T(If )I(x = 4)T( then done.)')
})

test('display maths becomes its own segment', () => {
  assert.equal(shape('So:\n$$a + b = c$$\ndone.'), 'T(So:\n)D(a + b = c)T(\ndone.)')
})

test('the real explanation that was rendering corrupted', () => {
  // Verbatim from the question bank. The old regex paired the second $ of "$$"
  // with the first $ of the closing "$$", inverting every delimiter after it:
  // prose rendered as maths and \ge leaked through as literal text.
  const source =
    'Minimizing $a_9$ requires\n$$135-a_9\\le 3a_9-6 \\implies 4a_9\\ge141,$$\nso $a_9\\ge36$. Checking $a_9=36$: we need values below $36$.'

  const segments = splitMath(source)
  const display = segments.filter((s) => s.kind === 'display')
  assert.equal(display.length, 1, 'the standalone equation is one display segment')
  assert.equal((display[0] as { tex: string }).tex, '135-a_9\\le 3a_9-6 \\implies 4a_9\\ge141,')

  // The crucial property: every word of prose stays prose.
  const prose = texts(source)
  assert.ok(prose.includes('so '), 'the word "so" must not be swallowed into maths')
  assert.ok(prose.includes('. Checking '), '"Checking" must not be swallowed into maths')
  assert.ok(prose.includes(': we need values below '))
  assert.ok(!prose.includes('\\ge'), 'no LaTeX command should leak into the prose')
  assert.ok(!prose.includes('$'), 'no stray delimiter should survive')
})

test('an escaped dollar is a literal dollar, not a delimiter', () => {
  assert.equal(shape('It costs \\$12 today.'), 'T(It costs $12 today.)')
  assert.equal(shape('\\$5 and \\$7'), 'T($5 and $7)')
})

test('a single unmatched dollar stays literal instead of eating the rest', () => {
  // This is the whole point: damage from a typo must stay local.
  assert.equal(shape('A stray $ sign here.'), 'T(A stray $ sign here.)')
  assert.equal(shape('Cost $12 for the item.'), 'T(Cost $12 for the item.)')
})

test('an odd number of delimiters does not invert the pairing', () => {
  const out = shape('$a$ and $b$ and $c')
  assert.equal(out, 'I(a)T( and )I(b)T( and $c)', 'the trailing stray dollar is literal')
})

test('maths is not allowed to span a paragraph break', () => {
  // A "$" whose partner is two paragraphs away is a typo, not an equation.
  const out = splitMath('Start $oops\n\nA new paragraph $ end.')
  assert.equal(out.every((s) => s.kind === 'text'), true)
  assert.ok(texts('Start $oops\n\nA new paragraph $ end.').includes('A new paragraph'))
})

test('empty delimiters are literal', () => {
  assert.equal(shape('$$'), 'T($$)')
  assert.equal(shape('$ $'), 'T($ $)')
})

test('unclosed display maths does not swallow the document', () => {
  const out = shape('Before $$x+1 and then more prose that never closes.')
  assert.ok(out.startsWith('T(Before $$x+1'), `got ${out}`)
  assert.ok(!out.includes('D('), 'nothing should be treated as display maths')
})

test('adjacent maths spans stay separate', () => {
  assert.equal(shape('$a$$b$'), 'I(a)I(b)')
})

test('a backslash before a dollar inside maths does not end the span early', () => {
  assert.equal(shape('$a \\$ b$ after'), 'I(a \\$ b)T( after)')
})

test('multiple display blocks in one explanation', () => {
  const out = shape('One:\n$$a=1$$\nTwo:\n$$b=2$$\ndone')
  assert.equal(out, 'T(One:\n)D(a=1)T(\nTwo:\n)D(b=2)T(\ndone)')
})

test('round trip: no character is invented or lost', () => {
  const sources = [
    'If $x = 4$ then $y$.',
    'Cost \\$12 and $z^2$',
    'A stray $ sign',
    'Display:\n$$a+b$$\nafter',
    'plain text only',
  ]
  for (const src of sources) {
    const rebuilt = splitMath(src)
      .map((s) =>
        s.kind === 'text' ? s.text : s.kind === 'inline' ? `$${s.tex}$` : `$$${s.tex}$$`,
      )
      .join('')
    // Escaped dollars legitimately become bare ones, so compare on that basis.
    assert.equal(rebuilt.replace(/\$\$/g, '$$'), src.replace(/\\\$/g, '$').replace(/\$\$/g, '$$'))
  }
})
