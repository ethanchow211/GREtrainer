/**
 * Splitting prose from the mathematics embedded in it.
 *
 * Questions come back as text with LaTeX between dollar signs, and sometimes a
 * standalone equation between double dollar signs:
 *
 *   Minimizing $a_9$ requires
 *   $$135 - a_9 \le 3a_9 - 6$$
 *   so $a_9 \ge 36$.
 *
 * This was originally a regular expression, which had a nasty failure mode. A
 * regex looking for `$...$` pairs sees `$$` as an opening delimiter plus a stray
 * dollar, so every delimiter after that point pairs up with the wrong partner:
 * prose renders as maths with its spaces collapsed, real maths renders as raw
 * backslash commands, and the damage runs to the end of the text rather than
 * staying local.
 *
 * A scanner fixes that, and lets an unmatched delimiter degrade into a literal
 * dollar sign instead of corrupting everything downstream.
 */

export type MathSegment =
  | { kind: 'text'; text: string }
  | { kind: 'inline'; tex: string }
  | { kind: 'display'; tex: string }

/**
 * An unmatched `$` is far more likely to be a typo than the start of maths that
 * runs across a paragraph break, so a candidate span containing a blank line is
 * rejected and the delimiter is treated as a literal dollar. This keeps one stray
 * character from swallowing the rest of an explanation.
 */
function spansParagraphs(text: string): boolean {
  return /\n\s*\n/.test(text)
}

/** Index of the next unescaped occurrence of `token`, or -1. */
function findUnescaped(source: string, token: string, from: number): number {
  let i = from
  while (i < source.length) {
    const at = source.indexOf(token, i)
    if (at === -1) return -1
    // Count the backslashes immediately before it; an odd number means escaped.
    let backslashes = 0
    let j = at - 1
    while (j >= 0 && source[j] === '\\') {
      backslashes++
      j--
    }
    if (backslashes % 2 === 0) return at
    i = at + 1
  }
  return -1
}

export function splitMath(source: string): MathSegment[] {
  const segments: MathSegment[] = []
  let text = ''
  let i = 0

  const flushText = (): void => {
    if (text !== '') {
      segments.push({ kind: 'text', text })
      text = ''
    }
  }

  while (i < source.length) {
    const ch = source[i] as string

    // An escaped dollar is a literal one -- a price, not the start of maths.
    if (ch === '\\' && source[i + 1] === '$') {
      text += '$'
      i += 2
      continue
    }

    if (ch !== '$') {
      text += ch
      i++
      continue
    }

    // Display maths: $$ ... $$
    if (source[i + 1] === '$') {
      const close = findUnescaped(source, '$$', i + 2)
      const tex = close === -1 ? null : source.slice(i + 2, close)
      if (tex !== null && tex.trim() !== '') {
        flushText()
        segments.push({ kind: 'display', tex: tex.trim() })
        i = close + 2
        continue
      }
      // Unclosed or empty: render both characters literally rather than guessing.
      text += '$$'
      i += 2
      continue
    }

    // Inline maths: $ ... $
    const close = findUnescaped(source, '$', i + 1)
    const tex = close === -1 ? null : source.slice(i + 1, close)
    if (tex !== null && tex.trim() !== '' && !spansParagraphs(tex)) {
      flushText()
      segments.push({ kind: 'inline', tex })
      i = close + 1
      continue
    }

    text += '$'
    i++
  }

  flushText()
  return segments
}
