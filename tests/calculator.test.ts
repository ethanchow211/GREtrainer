import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INITIAL_CALCULATOR_STATE,
  calculatorAllowedFor,
  calculatorReducer,
  displayText,
  type CalculatorAction,
  type CalculatorState,
} from '../src/ui/calculator.ts'

function enter(actions: CalculatorAction[], start: CalculatorState = INITIAL_CALCULATOR_STATE): CalculatorState {
  return actions.reduce(calculatorReducer, start)
}

test('calculator is available for quant questions only', () => {
  assert.equal(calculatorAllowedFor({ section: 'quant' }), true)
  assert.equal(calculatorAllowedFor({ section: 'verbal' }), false)
})

test('calculator performs all four arithmetic operations', () => {
  const examples: Array<{ operator: 'add' | 'subtract' | 'multiply' | 'divide'; expected: string }> = [
    { operator: 'add', expected: '11' },
    { operator: 'subtract', expected: '5' },
    { operator: 'multiply', expected: '24' },
    { operator: 'divide', expected: '2.66666666666667' },
  ]

  for (const example of examples) {
    const result = enter([
      { type: 'digit', digit: '8' },
      { type: 'operator', operator: example.operator },
      { type: 'digit', digit: '3' },
      { type: 'equals' },
    ])
    assert.equal(displayText(result), example.expected, example.operator)
  }
})

test('calculator accepts decimals and clears its state', () => {
  const result = enter([
    { type: 'digit', digit: '1' },
    { type: 'decimal' },
    { type: 'digit', digit: '5' },
    { type: 'operator', operator: 'multiply' },
    { type: 'digit', digit: '2' },
    { type: 'equals' },
  ])
  assert.equal(displayText(result), '3')

  assert.deepEqual(calculatorReducer(result, { type: 'clear' }), INITIAL_CALCULATOR_STATE)
})

test('calculator chains operations like a handheld calculator', () => {
  const result = enter([
    { type: 'digit', digit: '2' },
    { type: 'operator', operator: 'add' },
    { type: 'digit', digit: '3' },
    { type: 'operator', operator: 'multiply' },
    { type: 'digit', digit: '4' },
    { type: 'equals' },
  ])
  assert.equal(displayText(result), '20', '(2 + 3) × 4 is evaluated in entry order')
})

function digits(text: string): CalculatorAction[] {
  return [...text].map((digit) => ({ type: 'digit', digit }) as CalculatorAction)
}

test('calculator reports division by zero and locks every key except Clear', () => {
  const error = enter([...digits('7'), { type: 'operator', operator: 'divide' }, ...digits('0'), { type: 'equals' }])
  assert.equal(displayText(error), 'Error')
  assert.equal(error.expression, '7 ÷ 0 =')

  // Digits, operators, ± and = all do nothing while "Error" is showing.
  for (const action of [...digits('4'), { type: 'operator', operator: 'add' }, { type: 'toggle-sign' }, { type: 'equals' }] as CalculatorAction[]) {
    assert.equal(calculatorReducer(error, action), error, action.type)
  }
  assert.deepEqual(calculatorReducer(error, { type: 'clear' }), INITIAL_CALCULATOR_STATE)
})

test('calculation line shows what is being calculated', () => {
  const afterOperator = enter([...digits('12'), { type: 'operator', operator: 'multiply' }])
  assert.equal(afterOperator.expression, '12 ×')
  assert.equal(displayText(afterOperator), '12')

  const typingSecond = calculatorReducer(afterOperator, { type: 'digit', digit: '3' })
  assert.equal(typingSecond.expression, '12 ×')
  assert.equal(displayText(typingSecond), '3')

  const done = calculatorReducer(typingSecond, { type: 'equals' })
  assert.equal(done.expression, '12 × 3 =')
  assert.equal(displayText(done), '36')

  // Starting a new number after a result clears the old calculation line.
  assert.equal(calculatorReducer(done, { type: 'digit', digit: '5' }).expression, '')

  // Negative numbers are bracketed in the calculation line.
  const negative = enter([...digits('5'), { type: 'operator', operator: 'subtract' }, { type: 'toggle-sign' }, ...digits('3'), { type: 'equals' }])
  assert.equal(negative.expression, '5 − (-3) =')
  assert.equal(displayText(negative), '8')
})

test('± pressed before a number shows -() straight away', () => {
  const pressed = enter([{ type: 'toggle-sign' }])
  assert.equal(displayText(pressed), '-()')

  const typed = enter([{ type: 'toggle-sign' }, ...digits('12')])
  assert.equal(displayText(typed), '-(12)')

  // Pressing ± again before typing turns it back off.
  assert.equal(displayText(calculatorReducer(pressed, { type: 'toggle-sign' })), '0')

  // ± also works right after an operator, before the second number.
  const second = enter([...digits('4'), { type: 'operator', operator: 'multiply' }, { type: 'toggle-sign' }])
  assert.equal(displayText(second), '-()')
  const result = enter([...digits('4'), { type: 'operator', operator: 'multiply' }, { type: 'toggle-sign' }, ...digits('2'), { type: 'equals' }])
  assert.equal(displayText(result), '-8')

  // ± on a number already typed flips its sign.
  assert.equal(displayText(enter([...digits('7'), { type: 'toggle-sign' }])), '-(7)')
})

test('typing stops at 15 digits, and all 15 are kept through a calculation', () => {
  const typed = enter(digits('12345678901234567890'))
  assert.equal(displayText(typed), '123456789012345')

  const added = enter([{ type: 'operator', operator: 'add' }, ...digits('999999999999999'), { type: 'equals' }], typed)
  assert.equal(added.expression, '123456789012345 + 999999999999999 =')
  assert.equal(displayText(added), '1123456789012340', 'rounded to 15 significant digits')

  // Floating-point tails are still hidden.
  const tenths = enter([{ type: 'decimal' }, ...digits('1'), { type: 'operator', operator: 'add' }, { type: 'decimal' }, ...digits('2'), { type: 'equals' }])
  assert.equal(displayText(tenths), '0.3')
})

test('results bigger than 1e100 show Error instead of breaking', () => {
  // Build 1e99 by multiplying 15-digit numbers, then multiply by 1000.
  let state = enter([...digits('1'), { type: 'operator', operator: 'multiply' }])
  for (let i = 0; i < 99; i++) {
    state = calculatorReducer(state, { type: 'digit', digit: '1' })
    state = calculatorReducer(state, { type: 'digit', digit: '0' })
    state = calculatorReducer(state, { type: 'operator', operator: 'multiply' })
  }
  assert.equal(displayText(state), '1e+99', 'large results keep their e+ part')

  const overflow = enter([...digits('1000'), { type: 'equals' }], state)
  assert.equal(displayText(overflow), 'Error')
  assert.equal(overflow.expression, '1e+99 × 1000 =')

  // Exactly 1e100 is still allowed.
  const limit = enter([...digits('10'), { type: 'equals' }], state)
  assert.equal(displayText(limit), '1e+100')
})
