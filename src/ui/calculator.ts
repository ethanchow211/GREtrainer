/**
 * The calculator's arithmetic is kept separate from the React interface. That
 * makes the button behaviour easy to test without adding a browser-test package.
 * It behaves like a basic handheld calculator: each operation is completed in
 * the order entered rather than using algebraic order of operations.
 */

export type CalculatorOperator = 'add' | 'subtract' | 'multiply' | 'divide'

export type CalculatorState = {
  /**
   * The digits on screen, without any minus sign (for example "12" or "0.5").
   * An empty string means the user pressed ± but has not typed a digit yet.
   * The value 'Error' means the last calculation was invalid or too large.
   */
  entry: string
  /** True when the number on screen is negative. Kept apart from the digits so ± can be pressed first. */
  negative: boolean
  storedValue: number | null
  pendingOperator: CalculatorOperator | null
  /**
   * True when the screen shows a finished number (a result, or the first number
   * of a pending operation). The next digit then starts a fresh number.
   */
  replaceDisplay: boolean
  /** The calculation being performed, shown on a small line above the number, e.g. "12 × 3 =". */
  expression: string
}

export type CalculatorAction =
  | { type: 'digit'; digit: string }
  | { type: 'decimal' }
  | { type: 'operator'; operator: CalculatorOperator }
  | { type: 'equals' }
  | { type: 'toggle-sign' }
  | { type: 'clear' }

export const INITIAL_CALCULATOR_STATE: CalculatorState = {
  entry: '0',
  negative: false,
  storedValue: null,
  pendingOperator: null,
  replaceDisplay: false,
  expression: '',
}

/**
 * Limits that keep the calculator from breaking on huge numbers.
 * - Past 15 digits JavaScript numbers start silently rounding, so typing stops there.
 * - Results bigger than 1e100 (a 1 followed by 100 zeros) show "Error" instead.
 */
export const MAX_DIGITS = 15
export const MAX_MAGNITUDE = 1e100

export const OPERATOR_SYMBOLS: Record<CalculatorOperator, string> = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
}

const ERROR_STATE: CalculatorState = { ...INITIAL_CALCULATOR_STATE, entry: 'Error', replaceDisplay: true }

/** GRE calculator access follows the test section, not the answer format. */
export function calculatorAllowedFor(question: { section: string }): boolean {
  return question.section === 'quant'
}

/** True when the calculator is showing "Error" and only Clear will do anything. */
export function isError(state: CalculatorState): boolean {
  return state.entry === 'Error'
}

/** The big number on screen. While typing a negative number it reads "-(12)", so ± is visibly on. */
export function displayText(state: CalculatorState): string {
  if (isError(state)) return 'Error'
  if (!state.negative) return state.entry
  if (state.replaceDisplay) return `-${state.entry}`
  return `-(${state.entry})`
}

/** The number on screen as a JavaScript number. A lone "-()" counts as zero. */
function currentValue(state: CalculatorState): number {
  const magnitude = Number(state.entry === '' ? '0' : state.entry)
  return state.negative ? -magnitude : magnitude
}

/**
 * Results are rounded to 15 significant digits, the same as the typing limit.
 * That hides floating-point tails such as 0.1 + 0.2 = 0.30000000000000004.
 */
function formatNumber(value: number): string {
  return Number(value.toPrecision(MAX_DIGITS)).toString()
}

/**
 * A number for the calculation line; negatives get brackets so "5 − (-3)" reads clearly.
 * Numbers reaching here are already typed or already rounded, so they are shown
 * exactly rather than rounded a second time.
 */
function formatOperand(value: number): string {
  return value < 0 ? `(${value})` : `${value}`
}

/** Store a finished number on screen, splitting it into digits and sign. */
function showResult(state: CalculatorState, value: number): CalculatorState {
  const text = formatNumber(Math.abs(value))
  return { ...state, entry: text, negative: value < 0 && text !== '0', replaceDisplay: true }
}

/** Infinite, not-a-number (e.g. 7 ÷ 0) and absurdly large results all become "Error". */
function isTooBig(value: number): boolean {
  return !Number.isFinite(value) || Math.abs(value) > MAX_MAGNITUDE
}

function calculate(left: number, right: number, operator: CalculatorOperator): number {
  switch (operator) {
    case 'add':
      return left + right
    case 'subtract':
      return left - right
    case 'multiply':
      return left * right
    case 'divide':
      return right === 0 ? Number.NaN : left / right
  }
}

export function calculatorReducer(state: CalculatorState, action: CalculatorAction): CalculatorState {
  if (action.type === 'clear') return { ...INITIAL_CALCULATOR_STATE }

  // After an invalid or too-large result every key except Clear is locked, so a
  // broken value can never be carried into the next calculation.
  if (isError(state)) return state

  switch (action.type) {
    case 'digit': {
      // Start a new number after a result or after an operator was pressed.
      // With no operation pending, the old calculation line is finished, so clear it.
      if (state.replaceDisplay) {
        const expression = state.pendingOperator === null ? '' : state.expression
        return { ...state, entry: action.digit, negative: false, replaceDisplay: false, expression }
      }

      // Stop at 15 digits; beyond that JavaScript would quietly round the number.
      const digitCount = state.entry.replace(/[^0-9]/g, '').length
      if (digitCount >= MAX_DIGITS) return state

      const entry = state.entry === '0' || state.entry === '' ? action.digit : state.entry + action.digit
      return { ...state, entry }
    }

    case 'decimal': {
      if (state.replaceDisplay) {
        const expression = state.pendingOperator === null ? '' : state.expression
        return { ...state, entry: '0.', negative: false, replaceDisplay: false, expression }
      }
      if (state.entry.includes('.')) return state
      return { ...state, entry: state.entry === '' ? '0.' : `${state.entry}.` }
    }

    case 'toggle-sign': {
      // ± pressed before any digit (at the start, or right after an operator):
      // show "-()" straight away so the press is visibly confirmed. The digits
      // typed next fill in between the brackets.
      const nothingTypedYet = state.replaceDisplay ? state.pendingOperator !== null : state.entry === '0'
      if (nothingTypedYet) {
        return { ...state, entry: '', negative: true, replaceDisplay: false }
      }

      // A lone "-()" with no digits: pressing ± again turns it back off.
      if (state.entry === '') return { ...state, entry: '0', negative: false }

      // Otherwise flip the sign of the number on screen (typed or a result).
      if (state.entry === '0') return state
      return { ...state, negative: !state.negative }
    }

    case 'operator': {
      // Pressing a different operation twice in a row just changes the pending
      // operation; it does not calculate with the same number twice.
      if (state.pendingOperator !== null && state.replaceDisplay && state.storedValue !== null) {
        return {
          ...state,
          pendingOperator: action.operator,
          expression: `${formatOperand(state.storedValue)} ${OPERATOR_SYMBOLS[action.operator]}`,
        }
      }

      // Chained operation: finish the previous one first (2 + 3 × → 5 ×) and
      // show that result. Otherwise the typed number stays exactly as typed.
      let shown: CalculatorState = state
      if (state.pendingOperator !== null && state.storedValue !== null) {
        const left = calculate(state.storedValue, currentValue(state), state.pendingOperator)
        if (isTooBig(left)) return { ...ERROR_STATE }
        shown = showResult(state, left)
      } else if (state.entry === '') {
        // A lone "-()" counts as zero.
        shown = { ...state, entry: '0', negative: false }
      }
      const stored = currentValue(shown)
      return {
        ...shown,
        storedValue: stored,
        pendingOperator: action.operator,
        replaceDisplay: true,
        expression: `${formatOperand(stored)} ${OPERATOR_SYMBOLS[action.operator]}`,
      }
    }

    case 'equals': {
      if (state.storedValue === null || state.pendingOperator === null) return state

      const right = currentValue(state)
      const result = calculate(state.storedValue, right, state.pendingOperator)
      const expression = `${formatOperand(state.storedValue)} ${OPERATOR_SYMBOLS[state.pendingOperator]} ${formatOperand(right)} =`
      if (isTooBig(result)) return { ...ERROR_STATE, expression }

      return { ...showResult(state, result), storedValue: null, pendingOperator: null, expression }
    }
  }
}
