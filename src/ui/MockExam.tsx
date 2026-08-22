import { useCallback, useEffect, useRef, useState } from 'react'
import { QuestionView } from './QuestionView.tsx'
import { MathText } from './MathText.tsx'
import { api, type AnswerResponse, type MockExamState, type MockSectionResult, type PublicQuestion } from './api.ts'

/**
 * A timed mock exam, built to the published GRE structure minus the essay.
 *
 * Two things are deliberate here and differ from drilling:
 *
 * - **No feedback until the end.** The real test does not tell you how you are doing,
 *   and knowing mid-exam changes how you play the remaining sections.
 * - **The clock lives on the server.** Reloading the page does not buy extra time.
 */

type Phase = 'intro' | 'section' | 'between' | 'finished'

export function MockExam({ onError }: { onError: (e: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>('intro')
  const [exam, setExam] = useState<MockExamState | null>(null)
  const [readiness, setReadiness] = useState<{
    quant: number
    verbal: number
    needQuant: number
    needVerbal: number
  } | null>(null)
  const [scores, setScores] = useState<{
    quant: { score: number; correct: number; total: number }
    verbal: { score: number; correct: number; total: number }
  } | null>(null)
  const [results, setResults] = useState<Record<number, MockSectionResult>>({})
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    api.mockReadiness().then(setReadiness).catch(() => undefined)
  }, [])

  async function begin(): Promise<void> {
    setStarting(true)
    onError(null)
    try {
      const { exam: e } = await api.startMock()
      setExam(e)
      setPhase('section')
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  function onSectionDone(
    sectionIndex: number,
    r: MockSectionResult,
    updated: MockExamState,
    s: typeof scores,
  ): void {
    // Keyed by the section just submitted. exam.current has already moved on.
    setResults((prev) => ({ ...prev, [sectionIndex]: r }))
    setExam(updated)
    if (updated.finished) {
      setScores(s)
      setPhase('finished')
    } else {
      setPhase('between')
    }
  }

  if (phase === 'intro') {
    const short =
      readiness &&
      (readiness.quant < readiness.needQuant || readiness.verbal < readiness.needVerbal)

    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Timed mock exam</h2>
          <p className="mt-2 text-slate-600 dark:text-slate-400">
            Four sections, 88 minutes, no breaks. The essay is not included.
          </p>
        </div>

        <table className="text-sm">
          <tbody>
            {[
              ['Verbal 1', '12 questions', '18 min'],
              ['Verbal 2', '15 questions', '23 min'],
              ['Quant 1', '12 questions', '21 min'],
              ['Quant 2', '15 questions', '26 min'],
            ].map((row) => (
              <tr key={row[0]}>
                <td className="py-0.5 pr-6 font-medium">{row[0]}</td>
                <td className="py-0.5 pr-6 text-slate-500">{row[1]}</td>
                <td className="py-0.5 text-slate-500">{row[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="text-sm text-slate-600 dark:text-slate-400">
          Like the real test, this is <strong>section-adaptive</strong>: how you do on the first section of
          each measure sets the difficulty of the second. You will not see your score until the end.
        </p>

        {readiness && (
          <p className="text-sm text-slate-500">
            Question pool: {readiness.quant} quant (need {readiness.needQuant}), {readiness.verbal} verbal
            (need {readiness.needVerbal}).
            {short && ' Sections will be shorter than the real thing until the pool fills out.'}
          </p>
        )}

        <button
          type="button"
          onClick={begin}
          disabled={starting}
          className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {starting ? 'Assembling…' : 'Start the exam'}
        </button>
      </div>
    )
  }

  if (phase === 'between' && exam) {
    const next = exam.sections.find((s) => s.index === exam.current)
    return (
      <div className="space-y-5 py-10 text-center">
        <h2 className="text-xl font-semibold">Section complete</h2>
        <p className="text-slate-600 dark:text-slate-400">
          As on the real test, scores come at the end rather than between sections.
        </p>
        {next && (
          <p className="text-sm text-slate-500">
            Next: {next.section === 'quant' ? 'Quantitative' : 'Verbal'} Reasoning, section {next.order} —{' '}
            {next.questions.length} questions in {next.minutes} minutes.
          </p>
        )}
        <button
          type="button"
          onClick={() => setPhase('section')}
          className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white dark:bg-slate-100 dark:text-slate-900"
        >
          Begin next section
        </button>
      </div>
    )
  }

  if (phase === 'finished' && exam) {
    return <MockResults exam={exam} scores={scores} results={results} />
  }

  if (phase === 'section' && exam) {
    const sec = exam.sections.find((s) => s.index === exam.current)
    if (!sec) return <p className="text-slate-500">No section to run.</p>
    return (
      <SectionRunner
        key={sec.index}
        examId={exam.id}
        section={sec}
        onDone={onSectionDone}
        onError={onError}
      />
    )
  }

  return null
}

// -------------------------------------------------------------------- one section

function SectionRunner({
  examId,
  section,
  onDone,
  onError,
}: {
  examId: string
  section: MockExamState['sections'][number]
  onDone: (sectionIndex: number, r: MockSectionResult, exam: MockExamState, scores: never) => void
  onError: (e: string | null) => void
}) {
  const [at, setAt] = useState(0)
  const [answers, setAnswers] = useState<Record<string, AnswerResponse | null>>({})
  const [flagged, setFlagged] = useState<Set<string>>(new Set())
  const [secondsLeft, setSecondsLeft] = useState(section.minutes * 60)
  const [submitting, setSubmitting] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const spent = useRef<Record<string, number>>({})
  const enteredAt = useRef<number>(Date.now())
  const submitted = useRef(false)

  const question = section.questions[at]

  const submit = useCallback(async () => {
    if (submitted.current) return
    submitted.current = true
    setSubmitting(true)
    try {
      const r = await api.submitMockSection(examId, section.index, answers, spent.current)
      onDone(section.index, r.result, r.exam, r.scores as never)
    } catch (e) {
      submitted.current = false
      onError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }, [answers, examId, onDone, onError, section.index])

  // The clock is authoritative on the server; this only counts down from what it says.
  useEffect(() => {
    let cancelled = false
    api
      .startMockSection(examId, section.index)
      .then(({ startedAt, minutes }) => {
        if (cancelled) return
        const endsAt = new Date(startedAt).getTime() + minutes * 60_000
        const tick = () => {
          const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000))
          setSecondsLeft(left)
          if (left === 0) void submit()
        }
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      })
      .catch((e) => onError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [examId, section.index, submit, onError])

  function recordTime(): void {
    const id = question?.id
    if (!id) return
    spent.current[id] = (spent.current[id] ?? 0) + (Date.now() - enteredAt.current) / 1000
    enteredAt.current = Date.now()
  }

  function goTo(index: number): void {
    recordTime()
    setAt(Math.max(0, Math.min(section.questions.length - 1, index)))
    setShowReview(false)
  }

  const answeredCount = Object.values(answers).filter((v) => v !== null && v !== undefined).length
  const low = secondsLeft <= 300

  if (!question) return <p className="text-slate-500">This section has no questions.</p>

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-800">
        <div className="text-sm">
          <span className="font-medium">
            {section.section === 'quant' ? 'Quantitative' : 'Verbal'} Reasoning
          </span>
          <span className="ml-2 text-slate-500">
            section {section.order} · question {at + 1} of {section.questions.length}
          </span>
        </div>
        <div
          className={
            'tabular-nums font-medium ' + (low ? 'text-rose-600 dark:text-rose-400' : 'text-slate-600 dark:text-slate-400')
          }
          title="Time remaining in this section"
        >
          {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
        </div>
      </div>

      {showReview ? (
        <div className="space-y-4">
          <h3 className="font-medium">Review before submitting</h3>
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-10">
            {section.questions.map((q, i) => {
              const done = answers[q.id] != null
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => goTo(i)}
                  className={
                    'rounded border px-2 py-1.5 text-xs ' +
                    (done
                      ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                      : 'border-slate-300 dark:border-slate-700') +
                    (flagged.has(q.id) ? ' ring-2 ring-amber-400' : '')
                  }
                >
                  {i + 1}
                </button>
              )
            })}
          </div>
          <p className="text-sm text-slate-500">
            {answeredCount} of {section.questions.length} answered.
            {answeredCount < section.questions.length &&
              ' There is no penalty for a wrong answer, so guess rather than leaving anything blank.'}
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setShowReview(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 dark:border-slate-700"
            >
              Keep working
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting}
              className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
            >
              {submitting ? 'Submitting…' : 'Submit section'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <QuestionView
            key={question.id}
            question={question as PublicQuestion}
            disabled={false}
            onSubmit={(r) => {
              recordTime()
              setAnswers((prev) => ({ ...prev, [question.id]: r }))
              if (at < section.questions.length - 1) setAt(at + 1)
              else setShowReview(true)
            }}
          />

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
            <button
              type="button"
              onClick={() => goTo(at - 1)}
              disabled={at === 0}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => goTo(at + 1)}
              disabled={at >= section.questions.length - 1}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() =>
                setFlagged((prev) => {
                  const next = new Set(prev)
                  if (next.has(question.id)) next.delete(question.id)
                  else next.add(question.id)
                  return next
                })
              }
              className={
                'rounded-lg border px-4 py-2 text-sm ' +
                (flagged.has(question.id)
                  ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
                  : 'border-slate-300 dark:border-slate-700')
              }
            >
              {flagged.has(question.id) ? 'Flagged' : 'Flag for review'}
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => {
                recordTime()
                setShowReview(true)
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
            >
              Review &amp; submit
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------ results

function MockResults({
  exam,
  scores,
  results,
}: {
  exam: MockExamState
  scores: {
    quant: { score: number; correct: number; total: number }
    verbal: { score: number; correct: number; total: number }
  } | null
  results: Record<number, MockSectionResult>
}) {
  const [openSection, setOpenSection] = useState<number | null>(null)

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold tracking-tight">Mock exam complete</h2>

      {scores && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(['verbal', 'quant'] as const).map((k) => (
            <div key={k} className="rounded-xl border border-slate-300 p-5 dark:border-slate-700">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {k === 'quant' ? 'Quantitative' : 'Verbal'} Reasoning
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">{scores[k].score}</div>
              <div className="mt-1 text-sm text-slate-500">
                {scores[k].total === 0
                  ? 'not attempted — no questions available'
                  : `${scores[k].correct} of ${scores[k].total} correct`}
              </div>
              {scores[k].total > 0 && scores[k].total < 27 && (
                <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  Based on {scores[k].total} questions rather than the full 27, so treat it loosely.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-sm dark:bg-amber-950/30">
        <strong>These scores are an approximation, not an official concordance.</strong> They come from
        questions written in the style of the GRE, not from the real thing. Use official ETS practice tests
        to calibrate where you actually stand; use this to find what to work on.
      </div>

      <div className="space-y-2">
        {exam.sections.map((s) => {
          const r = results[s.index]
          return (
            <div key={s.index} className="rounded-lg border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setOpenSection(openSection === s.index ? null : s.index)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="font-medium capitalize">
                  {s.section === 'quant' ? 'Quantitative' : 'Verbal'} section {s.order}
                </span>
                <span className="text-sm text-slate-500">
                  {s.questions.length === 0 ? (
                    <span title="There were not enough verified questions in the pool to build this section">
                      not run — pool too small
                    </span>
                  ) : (
                    <>
                      {s.correct ?? 0}/{s.questions.length} · difficulty {s.level.toFixed(1)}
                    </>
                  )}
                </span>
              </button>

              {openSection === s.index && r && (
                <div className="space-y-4 border-t border-slate-200 px-4 py-4 dark:border-slate-800">
                  {r.perQuestion.map((pq, i) => {
                    const q = s.questions.find((x) => x.id === pq.questionId)
                    return (
                      <div key={pq.questionId} className="text-sm">
                        <div className="flex items-baseline gap-2">
                          <span className={pq.correct ? 'text-emerald-600' : 'text-rose-600'}>
                            {pq.correct ? '✓' : '✗'}
                          </span>
                          <span className="font-medium">Question {i + 1}</span>
                          {q && <span className="text-slate-500">· {q.subtopicLabel}</span>}
                          {pq.yourResponse === null && <span className="text-slate-400">· not answered</span>}
                        </div>
                        {q && (
                          <div className="mt-1 text-slate-600 dark:text-slate-400">
                            <MathText>{(q.stem || q.passage || '').slice(0, 220)}</MathText>
                          </div>
                        )}
                        {!pq.correct && (
                          <div className="mt-1 whitespace-pre-line text-slate-600 dark:text-slate-400">
                            <MathText>{pq.explanation.slice(0, 700)}</MathText>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-sm text-slate-500">
        Every question here has been folded into your topic estimates, and anything you missed is now in the
        review schedule.
      </p>
    </div>
  )
}
