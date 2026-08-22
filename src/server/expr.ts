/**
 * A deliberately tiny arithmetic evaluator.
 *
 * Purpose: when Claude writes a quant question it must also supply a `check` -- an
 * arithmetic expression that evaluates to the answer it claims, e.g. "(3*8-4)/5".
 * We compute that ourselves and compare. If the expression does not produce the
 * stated answer, the question is thrown away before you ever see it.
 *
 * This does NOT use eval() or the Function constructor. We never execute
 * model-written code; we parse a restricted grammar of numbers, five operators, a
 * handful of named functions, and parentheses. Anything else is a syntax error.
 * A recursive-descent parser over that grammar is about the smallest thing that is
 * genuinely safe.
 */

export type EvalOk = { ok: true; value: number }
export type EvalErr = { ok: false; error: string }
export type EvalResult = EvalOk | EvalErr

const FUNCTIONS: Record<string, { arity: number | 'variadic'; fn: (args: number[]) => number }> = {
  sqrt: { arity: 1, fn: ([x]) => Math.sqrt(x as number) },
  abs: { arity: 1, fn: ([x]) => Math.abs(x as number) },
  floor: { arity: 1, fn: ([x]) => Math.floor(x as number) },
  ceil: { arity: 1, fn: ([x]) => Math.ceil(x as number) },
  round: { arity: 1, fn: ([x]) => Math.round(x as number) },
  pow: { arity: 2, fn: ([a, b]) => Math.pow(a as number, b as number) },
  min: { arity: 'variadic', fn: (a) => Math.min(...a) },
  max: { arity: 'variadic', fn: (a) => Math.max(...a) },
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '^' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }

class ParseError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < src.length) {
    const ch = src[i] as string

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < src.length && (src[j] as string) >= '0' && (src[j] as string) <= '9') j++
      if (src[j] === '.') {
        j++
        while (j < src.length && (src[j] as string) >= '0' && (src[j] as string) <= '9') j++
      }
      const text = src.slice(i, j)
      const value = Number(text)
      if (!Number.isFinite(value)) throw new ParseError(`bad number "${text}"`)
      tokens.push({ kind: 'num', value })
      i = j
      continue
    }

    // A leading "." as in ".5"
    if (ch === '.') {
      let j = i + 1
      while (j < src.length && (src[j] as string) >= '0' && (src[j] as string) <= '9') j++
      if (j === i + 1) throw new ParseError('stray "."')
      tokens.push({ kind: 'num', value: Number(src.slice(i, j)) })
      i = j
      continue
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let j = i
      while (j < src.length && /[A-Za-z_]/.test(src[j] as string)) j++
      tokens.push({ kind: 'name', value: src.slice(i, j).toLowerCase() })
      i = j
      continue
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
      // Accept "**" as a synonym for "^", since it is a common way to write powers.
      if (ch === '*' && src[i + 1] === '*') {
        tokens.push({ kind: 'op', value: '^' })
        i += 2
        continue
      }
      tokens.push({ kind: 'op', value: ch })
      i++
      continue
    }

    if (ch === '(') {
      tokens.push({ kind: 'lparen' })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' })
      i++
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' })
      i++
      continue
    }

    throw new ParseError(`unexpected character "${ch}"`)
  }

  return tokens
}

/**
 * Grammar, loosest binding first:
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/") unary)*
 *   unary  := ("+" | "-") unary | power
 *   power  := primary ("^" unary)?          -- right associative, so 2^3^2 = 2^9
 *   primary:= number | name | name "(" args ")" | "(" expr ")"
 */
function parse(tokens: Token[]): number {
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]

  const expect = (kind: Token['kind']): Token => {
    const t = tokens[pos]
    if (!t || t.kind !== kind) throw new ParseError(`expected ${kind}`)
    pos++
    return t
  }

  function parseExpr(): number {
    let left = parseTerm()
    for (;;) {
      const t = peek()
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        pos++
        const right = parseTerm()
        left = t.value === '+' ? left + right : left - right
      } else {
        return left
      }
    }
  }

  function parseTerm(): number {
    let left = parseUnary()
    for (;;) {
      const t = peek()
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/')) {
        pos++
        const right = parseUnary()
        if (t.value === '/') {
          if (right === 0) throw new ParseError('division by zero')
          left = left / right
        } else {
          left = left * right
        }
      } else {
        return left
      }
    }
  }

  function parseUnary(): number {
    const t = peek()
    if (t?.kind === 'op' && (t.value === '-' || t.value === '+')) {
      pos++
      const v = parseUnary()
      return t.value === '-' ? -v : v
    }
    return parsePower()
  }

  function parsePower(): number {
    const base = parsePrimary()
    const t = peek()
    if (t?.kind === 'op' && t.value === '^') {
      pos++
      const exp = parseUnary() // right associative, and allows 2^-1
      return Math.pow(base, exp)
    }
    return base
  }

  function parsePrimary(): number {
    const t = peek()
    if (!t) throw new ParseError('unexpected end of expression')

    if (t.kind === 'num') {
      pos++
      return t.value
    }

    if (t.kind === 'lparen') {
      pos++
      const v = parseExpr()
      expect('rparen')
      return v
    }

    if (t.kind === 'name') {
      pos++
      const next = peek()
      if (next?.kind === 'lparen') {
        pos++
        const args: number[] = []
        if (peek()?.kind !== 'rparen') {
          args.push(parseExpr())
          while (peek()?.kind === 'comma') {
            pos++
            args.push(parseExpr())
          }
        }
        expect('rparen')

        const fn = FUNCTIONS[t.value]
        if (!fn) throw new ParseError(`unknown function "${t.value}"`)
        if (fn.arity !== 'variadic' && fn.arity !== args.length) {
          throw new ParseError(`${t.value} takes ${fn.arity} argument(s), got ${args.length}`)
        }
        if (args.length === 0) throw new ParseError(`${t.value} needs at least one argument`)
        return fn.fn(args)
      }

      const constant = CONSTANTS[t.value]
      if (constant === undefined) throw new ParseError(`unknown name "${t.value}"`)
      return constant
    }

    throw new ParseError('unexpected token')
  }

  const value = parseExpr()
  if (pos !== tokens.length) throw new ParseError('trailing characters after expression')
  return value
}

/** Evaluate a restricted arithmetic expression. Never throws; returns a result. */
export function evaluate(source: string): EvalResult {
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, error: 'empty expression' }
  }
  if (source.length > 500) {
    return { ok: false, error: 'expression too long' }
  }
  try {
    const value = parse(tokenize(source))
    if (!Number.isFinite(value)) return { ok: false, error: 'result is not a finite number' }
    return { ok: true, value }
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message }
    return { ok: false, error: `could not evaluate: ${String(e)}` }
  }
}

/**
 * Compare a computed value against a claimed answer.
 *
 * Tolerance matters: a question whose answer is 1/3 may legitimately be stated as
 * 0.33. We accept a small relative difference rather than demanding exact equality.
 */
export function matchesAnswer(computed: number, claimed: number, tolerance = 1e-6): boolean {
  if (!Number.isFinite(computed) || !Number.isFinite(claimed)) return false
  const diff = Math.abs(computed - claimed)
  if (diff <= tolerance) return true
  const scale = Math.max(Math.abs(computed), Math.abs(claimed))
  return diff / scale <= 1e-3
}
