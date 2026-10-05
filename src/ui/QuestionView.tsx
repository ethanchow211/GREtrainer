import { useEffect, useState } from 'react'
import { Calculator } from './Calculator.tsx'
import { MathText } from './MathText.tsx'
import type { AnswerResponse, PublicQuestion } from './api.ts'
import { calculatorAllowedFor } from './calculator.ts'

/**
 * One question, in whichever of the six answer formats it happens to be.
 *
 * The component owns what you have picked but never knows the correct answer --
 * grading happens on the server, so the key is not sitting in the page while you
 * are still thinking.
 */

const LETTERS = 'ABCDEF'

type Props = {
  question: PublicQuestion
  disabled: boolean
  /** Set once the question has been answered, so the result can be shown inline. */
  result?: { correct: boolean; correctIndices?: number[]; correctValue?: number }
  onSubmit: (response: AnswerResponse) => void
}

export function QuestionView({ question, disabled, result, onSubmit }: Props) {
  const [picked, setPicked] = useState<number[]>([])
  const [blankPicks, setBlankPicks] = useState<number[]>([])
  const [typed, setTyped] = useState('')

  // Reset whenever a new question arrives.
  useEffect(() => {
    setPicked([])
    setBlankPicks(new Array(question.blanks?.length ?? 0).fill(-1))
    setTyped('')
  }, [question.id, question.blanks?.length])

  const isMulti = question.chooseExactly === undefined || question.chooseExactly > 1

  function toggle(index: number): void {
    if (disabled) return
    if (question.chooseExactly === 1) {
      setPicked([index])
      return
    }
    setPicked((prev) => {
      if (prev.includes(index)) return prev.filter((i) => i !== index)
      // Sentence Equivalence takes exactly two; a third pick replaces the oldest.
      if (question.chooseExactly !== undefined && prev.length >= question.chooseExactly) {
        return [...prev.slice(1), index]
      }
      return [...prev, index]
    })
  }

  function ready(): boolean {
    if (question.numericEntry) return typed.trim() !== ''
    if (question.blanks) return blankPicks.length > 0 && blankPicks.every((v) => v >= 0)
    if (question.chooseExactly !== undefined) return picked.length === question.chooseExactly
    return picked.length > 0
  }

  function submit(): void {
    if (!ready() || disabled) return
    if (question.numericEntry) onSubmit({ kind: 'numeric', value: typed })
    else if (question.blanks) onSubmit({ kind: 'blanks', indices: blankPicks })
    else onSubmit({ kind: 'choice', indices: [...picked].sort((a, b) => a - b) })
  }

  const correctSet = new Set(result?.correctIndices ?? [])

  function optionClass(index: number, chosen: boolean): string {
    const base =
      'flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition ' +
      'border-slate-300 dark:border-slate-700'
    if (!result) {
      return chosen
        ? `${base} border-sky-500 bg-sky-50 dark:bg-sky-950/40`
        : `${base} hover:border-slate-400 dark:hover:border-slate-500`
    }
    if (correctSet.has(index)) return `${base} border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40`
    if (chosen) return `${base} border-rose-500 bg-rose-50 dark:bg-rose-950/40`
    return `${base} opacity-60`
  }

  return (
    // Two columns: the question on the left, and on quantitative questions the
    // calculator on the right. min-w-0 lets long passages wrap instead of
    // pushing the calculator off the edge.
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1 space-y-5">
        {question.passage && (
          <div className="rounded-lg bg-slate-100 p-4 text-[15px] leading-relaxed dark:bg-slate-800/60">
            <MathText>{question.passage}</MathText>
          </div>
        )}

        {question.stem.trim() && (
          <p className="text-lg leading-relaxed">
            <MathText>{question.stem}</MathText>
          </p>
        )}

        {question.quantityA !== undefined && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-300 p-4 dark:border-slate-700">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Quantity A</div>
              <div className="text-lg">
                <MathText>{question.quantityA}</MathText>
              </div>
            </div>
            <div className="rounded-lg border border-slate-300 p-4 dark:border-slate-700">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Quantity B</div>
              <div className="text-lg">
                <MathText>{question.quantityB ?? ''}</MathText>
              </div>
            </div>
          </div>
        )}

        {/* Text Completion: one option list per blank. */}
        {question.blanks && (
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${question.blanks.length}, minmax(0, 1fr))` }}>
            {question.blanks.map((blank, bi) => (
              <div key={bi} className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Blank {question.blanks!.length > 1 ? `(${'i'.repeat(bi + 1)})` : ''}
                </div>
                {blank.options.map((opt, oi) => {
                  const chosen = blankPicks[bi] === oi
                  const isCorrect = result && (result.correctIndices ?? [])[bi] === oi
                  const cls = !result
                    ? chosen
                      ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
                      : 'border-slate-300 hover:border-slate-400 dark:border-slate-700'
                    : isCorrect
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                      : chosen
                        ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/40'
                        : 'border-slate-300 opacity-60 dark:border-slate-700'
                  return (
                    <button
                      key={oi}
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        setBlankPicks((prev) => {
                          const next = [...prev]
                          next[bi] = oi
                          return next
                        })
                      }
                      className={`w-full rounded-lg border px-3 py-2 text-left transition ${cls}`}
                    >
                      <span className="mr-2 text-xs text-slate-500">{LETTERS[oi]}</span>
                      <MathText>{opt}</MathText>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {question.options && !question.blanks && (
          <div className="space-y-2">
            {question.options.map((opt, i) => (
              <button
                key={i}
                type="button"
                disabled={disabled}
                onClick={() => toggle(i)}
                className={optionClass(i, picked.includes(i))}
              >
                <span
                  className={
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-xs font-semibold ' +
                    (isMulti ? 'rounded border' : 'rounded-full border') +
                    ' border-slate-400 dark:border-slate-600'
                  }
                >
                  {LETTERS[i]}
                </span>
                <span className="flex-1">
                  <MathText>{opt}</MathText>
                </span>
              </button>
            ))}
          </div>
        )}

        {question.numericEntry && (
          <div className="space-y-2">
            <input
              value={typed}
              disabled={disabled}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="Type your answer"
              inputMode="text"
              className="w-56 rounded-lg border border-slate-300 px-4 py-3 text-lg dark:border-slate-700 dark:bg-slate-900"
            />
            <p className="text-xs text-slate-500">Fractions are fine — type 3/4 or 0.75.</p>
            {result && !result.correct && (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Correct answer: <span className="font-semibold">{result.correctValue}</span>
              </p>
            )}
          </div>
        )}

        {question.chooseExactly !== undefined && question.chooseExactly > 1 && !result && (
          <p className="text-sm text-slate-500">
            Choose exactly {question.chooseExactly}. {picked.length} selected.
          </p>
        )}

        {!result && (
          <button
            type="button"
            onClick={submit}
            disabled={!ready() || disabled}
            className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white transition disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
          >
            Submit
          </button>
        )}
      </div>

      {calculatorAllowedFor(question) && <Calculator key={question.id} />}
    </div>
  )
}
