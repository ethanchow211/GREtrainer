import { useReducer, useState } from 'react'
import {
  INITIAL_CALCULATOR_STATE,
  OPERATOR_SYMBOLS,
  calculatorReducer,
  displayText,
  isError,
  type CalculatorAction,
} from './calculator.ts'

/**
 * A small calculator drawing (a body, a screen and a grid of keys), written as
 * inline SVG so no icon package is needed.
 */
function CalculatorIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="2.5" width="14" height="19" rx="2" />
      <rect x="8" y="5.5" width="8" height="3.5" rx="0.5" />
      <path d="M8.5 12.5h.01M12 12.5h.01M15.5 12.5h.01M8.5 15.5h.01M12 15.5h.01M15.5 15.5h.01M8.5 18.5h.01M12 18.5h.01M15.5 18.5h.01" />
    </svg>
  )
}

/**
 * Long numbers (like 1.23456789012e+99) get a smaller font so the whole number,
 * including the part after "e+", stays visible inside the display.
 */
function displaySizeClass(text: string): string {
  if (text.length <= 12) return 'text-2xl'
  if (text.length <= 16) return 'text-xl'
  if (text.length <= 19) return 'text-base'
  return 'text-sm'
}

/** A compact four-function calculator modelled on the GRE's on-screen tool. */
export function Calculator() {
  const [open, setOpen] = useState(false)
  const [state, dispatch] = useReducer(calculatorReducer, INITIAL_CALCULATOR_STATE)
  const shown = displayText(state)
  // While "Error" is showing, only Clear works, so grey out every other key.
  const locked = isError(state)

  // Normal keys are white; the "=" key is dark. The colours are picked here rather
  // than layered, because two background classes on one button fight each other.
  const NORMAL_KEY = 'bg-white hover:bg-slate-50 active:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700'
  const EQUALS_KEY = 'bg-slate-800 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200'

  function button(label: string, action: CalculatorAction, extraClass = '') {
    const colours = action.type === 'equals' ? EQUALS_KEY : NORMAL_KEY
    return (
      <button
        type="button"
        onClick={() => dispatch(action)}
        disabled={locked && action.type !== 'clear'}
        className={`rounded border border-slate-300 py-2 text-sm font-medium shadow-sm disabled:opacity-40 dark:border-slate-600 ${colours} ${extraClass}`}
      >
        {label}
      </button>
    )
  }

  return (
    // Sits in the right-hand column next to the question; the icon stays in the top-right corner.
    <div className="flex shrink-0 flex-col items-end">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Hide calculator' : 'Show calculator'}
        title={open ? 'Hide calculator' : 'Calculator'}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={`rounded-lg border p-2 hover:bg-slate-50 dark:hover:bg-slate-800 ${
          open ? 'border-sky-500 text-sky-600 dark:text-sky-400' : 'border-slate-300 dark:border-slate-700'
        }`}
      >
        <CalculatorIcon />
      </button>

      {open && (
        <div
          aria-label="Calculator"
          className="mt-2 w-64 rounded-lg border border-slate-300 bg-slate-100 p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="mb-3 rounded border border-slate-400 bg-white px-3 py-2 text-right font-mono dark:bg-slate-950">
            {/* Top line: the calculation being performed, e.g. "12 × 3 =". */}
            <div className="min-h-4 break-all text-xs text-slate-500">{state.expression}</div>
            {/* Bottom line: the number being typed or the result. break-all lets it wrap instead of being cut off. */}
            <output aria-live="polite" className={`block break-all leading-tight ${displaySizeClass(shown)}`}>
              {shown}
            </output>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {button('C', { type: 'clear' }, 'col-span-2')}
            {button('+/−', { type: 'toggle-sign' })}
            {button(OPERATOR_SYMBOLS.divide, { type: 'operator', operator: 'divide' })}

            {button('7', { type: 'digit', digit: '7' })}
            {button('8', { type: 'digit', digit: '8' })}
            {button('9', { type: 'digit', digit: '9' })}
            {button(OPERATOR_SYMBOLS.multiply, { type: 'operator', operator: 'multiply' })}

            {button('4', { type: 'digit', digit: '4' })}
            {button('5', { type: 'digit', digit: '5' })}
            {button('6', { type: 'digit', digit: '6' })}
            {button(OPERATOR_SYMBOLS.subtract, { type: 'operator', operator: 'subtract' })}

            {button('1', { type: 'digit', digit: '1' })}
            {button('2', { type: 'digit', digit: '2' })}
            {button('3', { type: 'digit', digit: '3' })}
            {button(OPERATOR_SYMBOLS.add, { type: 'operator', operator: 'add' })}

            {button('0', { type: 'digit', digit: '0' }, 'col-span-2')}
            {button('.', { type: 'decimal' })}
            {button('=', { type: 'equals' })}
          </div>
        </div>
      )}
    </div>
  )
}
