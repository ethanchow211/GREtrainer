import { useCallback, useEffect, useRef, useState } from 'react'
import { QuestionView } from './QuestionView.tsx'
import { MathText } from './MathText.tsx'
import { StrategyReader } from './StrategyReader.tsx'
import { MockExam } from './MockExam.tsx'
import {
  api,
  type AnswerResponse,
  type Coaching,
  type GradeResult,
  type MasteryRow,
  type PublicQuestion,
  type Stats,
  type Status,
} from './api.ts'

type Screen = 'start' | 'drill' | 'progress' | 'strategies' | 'mock'

export function App() {
  const [screen, setScreen] = useState<Screen>('start')
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = useCallback(() => {
    api.status().then(setStatus).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshStatus()
    const t = setInterval(refreshStatus, 15_000)
    return () => clearInterval(t)
  }, [refreshStatus])

  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <button
            type="button"
            onClick={() => setScreen('start')}
            className="text-sm font-semibold tracking-tight"
          >
            GRE Trainer
          </button>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            {status && (
              <>
                <span title="Verified questions ready to serve without waiting">
                  {status.buffer.ready} ready
                  {status.buffer.running && <span className="ml-1 animate-pulse">·</span>}
                </span>
                <span title="Claude calls used today, against your daily cap">
                  {status.budget.used}/{status.budget.limit} calls
                </span>
              </>
            )}
            <button type="button" onClick={() => setScreen('mock')} className="underline underline-offset-2">
              Mock exam
            </button>
            <button type="button" onClick={() => setScreen('strategies')} className="underline underline-offset-2">
              Strategies
            </button>
            <button type="button" onClick={() => setScreen('progress')} className="underline underline-offset-2">
              Progress
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8">
        {error && (
          <div className="mb-6 rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-sm dark:bg-amber-950/30">
            {error}
            <button type="button" onClick={() => setError(null)} className="ml-3 underline">
              dismiss
            </button>
          </div>
        )}

        {screen === 'start' && <StartScreen status={status} onStart={() => setScreen('drill')} setError={setError} />}
        {screen === 'drill' && <Drill onError={setError} onStatusChange={refreshStatus} />}
        {screen === 'progress' && <Progress />}
        {screen === 'strategies' && <Strategies />}
        {screen === 'mock' && <MockExam onError={setError} />}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------- start

let activeSession: string | null = null

function StartScreen({
  status,
  onStart,
  setError,
}: {
  status: Status | null
  onStart: () => void
  setError: (e: string | null) => void
}) {
  const [starting, setStarting] = useState(false)

  async function begin(section: string): Promise<void> {
    setStarting(true)
    setError(null)
    try {
      const s = await api.startSession(section)
      activeSession = s.sessionId
      onStart()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const cliBroken = status?.claude.error

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">What are you drilling?</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-400">
          Questions are written fresh by Claude and checked before you see them. The topics you are weakest
          at come up most.
        </p>
      </div>

      {cliBroken && (
        <div className="rounded-lg border border-rose-400 bg-rose-50 px-4 py-3 text-sm dark:bg-rose-950/30">
          <strong>Claude is not reachable.</strong>
          <p className="mt-1">{cliBroken}</p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { id: 'both', label: 'Mixed', hint: 'Quant and Verbal together, the way the test runs' },
          { id: 'quant', label: 'Quant', hint: `${status?.ready.quant ?? 0} ready` },
          { id: 'verbal', label: 'Verbal', hint: `${status?.ready.verbal ?? 0} ready` },
        ].map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={starting}
            onClick={() => begin(opt.id)}
            className="rounded-xl border border-slate-300 px-5 py-4 text-left transition hover:border-slate-500 disabled:opacity-50 dark:border-slate-700"
          >
            <div className="font-medium">{opt.label}</div>
            <div className="mt-1 text-xs text-slate-500">{opt.hint}</div>
          </button>
        ))}
      </div>

      {status && status.budget.remaining < 10 && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          {status.budget.remaining} Claude calls left today. Once they run out you can still work through
          questions already prepared, but no new ones will be written until tomorrow.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------- drill

function Drill({ onError, onStatusChange }: { onError: (e: string | null) => void; onStatusChange: () => void }) {
  const [question, setQuestion] = useState<PublicQuestion | null>(null)
  const [result, setResult] = useState<GradeResult | null>(null)
  const [response, setResponse] = useState<AnswerResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [waitingLong, setWaitingLong] = useState(false)
  const startedAt = useRef<number>(Date.now())

  const load = useCallback(async () => {
    if (!activeSession) return
    setLoading(true)
    setWaitingLong(false)
    setResult(null)
    setResponse(null)
    const slow = setTimeout(() => setWaitingLong(true), 2500)
    try {
      const { question: q } = await api.next(activeSession)
      setQuestion(q)
      startedAt.current = Date.now()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      clearTimeout(slow)
      setLoading(false)
      onStatusChange()
    }
  }, [onError, onStatusChange])

  useEffect(() => {
    void load()
  }, [load])

  async function submit(r: AnswerResponse): Promise<void> {
    if (!activeSession || !question) return
    const seconds = (Date.now() - startedAt.current) / 1000
    setResponse(r)
    try {
      const graded = await api.answer(activeSession, question.id, r, seconds)
      setResult(graded)
      onStatusChange()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  if (loading && !question) {
    return (
      <div className="py-16 text-center text-slate-500">
        <p>{waitingLong ? 'Writing a new question and checking it…' : 'Loading…'}</p>
        {waitingLong && (
          <p className="mt-2 text-xs">
            Nothing was in stock for this topic, so one is being written now. This takes about half a minute
            and only happens when the pool runs dry.
          </p>
        )}
      </div>
    )
  }

  if (!question) return <p className="text-slate-500">No question available.</p>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {question.group} · {question.subtopicLabel}
          {question.mode === 'review' && (
            <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 dark:bg-slate-800">review</span>
          )}
        </span>
        <span>difficulty {question.difficulty}/5</span>
      </div>

      <QuestionView
        question={question}
        disabled={result !== null}
        result={result ?? undefined}
        onSubmit={submit}
      />

      {result && (
        <ResultPanel
          question={question}
          result={result}
          response={response}
          onNext={() => void load()}
          onError={onError}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- result

function ResultPanel({
  question,
  result,
  response,
  onNext,
  onError,
}: {
  question: PublicQuestion
  result: GradeResult
  response: AnswerResponse | null
  onNext: () => void
  onError: (e: string | null) => void
}) {
  const [coaching, setCoaching] = useState<Coaching | null>(null)
  const [coachLoading, setCoachLoading] = useState(false)
  const [tagged, setTagged] = useState<string | null>(null)
  const [openStrategy, setOpenStrategy] = useState<string | null>(null)

  // Which written pages address the error you just tagged.
  const suggested = result.errorTags.find((t) => t.id === tagged)?.strategies ?? []

  // Ask for a personal diagnosis automatically whenever something was missed.
  useEffect(() => {
    if (result.correct || !response) return
    let cancelled = false
    setCoachLoading(true)
    api
      .coach(question.id, response)
      .then((c) => {
        if (cancelled) return
        setCoaching(c)
        // The model's chosen tag becomes the default, so recording why is one click.
        setTagged(c.errorTag)
        void api.tag(result.attemptId, c.errorTag).catch(() => undefined)
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setCoachLoading(false))
    return () => {
      cancelled = true
    }
  }, [question.id, result.attemptId, result.correct, response])

  function chooseTag(id: string): void {
    setTagged(id)
    api.tag(result.attemptId, id).catch((e) => onError((e as Error).message))
  }

  return (
    <div className="space-y-5 border-t border-slate-200 pt-5 dark:border-slate-800">
      <div className={result.correct ? 'font-semibold text-emerald-600' : 'font-semibold text-rose-600'}>
        {result.correct ? 'Correct' : 'Not right'}
      </div>

      {!result.correct && (
        <div className="rounded-lg bg-slate-50 p-4 dark:bg-slate-900">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">What went wrong</div>
          {coachLoading && <p className="mt-2 text-sm text-slate-500">Working out where this went wrong…</p>}
          {coaching && (
            <div className="mt-2 space-y-2 text-[15px] leading-relaxed">
              <p>{coaching.diagnosis}</p>
              <p className="text-slate-600 dark:text-slate-400">
                <span className="font-medium">Next time: </span>
                {coaching.nextTime}
              </p>
            </div>
          )}
          {!coachLoading && !coaching && (
            <p className="mt-2 text-sm text-slate-500">
              No personalised note this time — the explanation below still applies.
            </p>
          )}
        </div>
      )}

      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Explanation</div>
        <div className="mt-2 whitespace-pre-line text-[15px] leading-relaxed">
          <MathText>{result.explanation}</MathText>
        </div>
      </div>

      {!result.correct && result.errorTags.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Why did you miss it?
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {result.errorTags.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.hint}
                onClick={() => chooseTag(t.id)}
                className={
                  'rounded-full border px-3 py-1 text-xs transition ' +
                  (tagged === t.id
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
                    : 'border-slate-300 hover:border-slate-500 dark:border-slate-700')
                }
              >
                {t.label}
              </button>
            ))}
          </div>

          {suggested.length > 0 && (
            <div className="mt-3 text-sm">
              <span className="text-slate-500">Worth reading: </span>
              {suggested.map((s, i) => (
                <span key={s}>
                  {i > 0 && <span className="text-slate-400">, </span>}
                  <button
                    type="button"
                    onClick={() => setOpenStrategy(s)}
                    className="text-sky-600 underline underline-offset-2 dark:text-sky-400"
                  >
                    {s}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {openStrategy && <StrategyReader title={openStrategy} onClose={() => setOpenStrategy(null)} />}

      <button
        type="button"
        onClick={onNext}
        autoFocus
        className="rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white dark:bg-slate-100 dark:text-slate-900"
      >
        Next question
      </button>
    </div>
  )
}

// -------------------------------------------------------------------------- progress

function Progress() {
  const [rows, setRows] = useState<MasteryRow[] | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [openStrategy, setOpenStrategy] = useState<string | null>(null)

  useEffect(() => {
    api.mastery().then((r) => setRows(r.mastery)).catch(() => setRows([]))
    api.stats().then(setStats).catch(() => undefined)
  }, [])

  if (!rows) return <p className="text-slate-500">Loading…</p>

  const touched = rows.filter((r) => r.attempts > 0)
  const groups = [...new Set(rows.map((r) => r.group))]

  return (
    <div className="space-y-8">
      {stats && stats.totalAttempts > 0 && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Why you miss questions</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              More useful than a topic breakdown. Knowing that most of your misses are arithmetic slips
              rather than concept gaps changes what is worth practising — extra topic drilling does not fix
              a slip problem.
            </p>
          </div>

          {stats.sections
            .filter((sec) => sec.attempts > 0)
            .map((sec) => {
              const misses = sec.attempts - sec.correct
              const pace = stats.pacing.find((p) => p.section === sec.section)
              return (
                <div key={sec.section} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-medium capitalize">{sec.section}</h3>
                    <div className="text-sm text-slate-500">
                      {sec.correct}/{sec.attempts} correct ({Math.round(sec.accuracy * 100)}%)
                      {pace && (
                        <span
                          className={
                            'ml-3 ' + (pace.medianSeconds > pace.parSeconds ? 'text-amber-600 dark:text-amber-400' : '')
                          }
                          title={`The real test gives you about ${pace.parSeconds} seconds per question in this section`}
                        >
                          {pace.medianSeconds}s median · {pace.parSeconds}s budget
                        </span>
                      )}
                    </div>
                  </div>

                  {misses === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">Nothing missed yet.</p>
                  ) : (
                    <div className="mt-3 space-y-1.5">
                      {sec.errors.map((e) => (
                        <div key={e.tag} className="flex items-center gap-3 text-sm">
                          <div className="w-48 shrink-0 truncate">{e.label}</div>
                          <div className="h-2.5 flex-1 rounded-full bg-slate-200 dark:bg-slate-800">
                            <div
                              className="h-2.5 rounded-full bg-rose-500/70"
                              style={{ width: `${Math.max(2, e.share * 100)}%` }}
                            />
                          </div>
                          <div className="w-16 shrink-0 text-right tabular-nums text-slate-500">
                            {Math.round(e.share * 100)}% · {e.count}
                          </div>
                        </div>
                      ))}

                      {sec.errors[0] && sec.errors[0].strategies.length > 0 && (
                        <p className="pt-2 text-sm">
                          <span className="text-slate-500">Your most common miss points at: </span>
                          {sec.errors[0].strategies.map((st, i) => (
                            <span key={st}>
                              {i > 0 && <span className="text-slate-400">, </span>}
                              <button
                                type="button"
                                onClick={() => setOpenStrategy(st)}
                                className="text-sky-600 underline underline-offset-2 dark:text-sky-400"
                              >
                                {st}
                              </button>
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

          {stats.weakest.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Weakest topics (at least 3 attempts)
              </h3>
              <div className="space-y-1 text-sm">
                {stats.weakest.map((w) => (
                  <div key={w.subtopic} className="flex justify-between">
                    <span>
                      {w.label} <span className="text-slate-400">· {w.group}</span>
                    </span>
                    <span className="tabular-nums text-slate-500">
                      {w.correct}/{w.attempts}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {openStrategy && <StrategyReader title={openStrategy} onClose={() => setOpenStrategy(null)} />}

      <div>
        <h2 className="text-xl font-semibold tracking-tight">Where you stand</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          The bar is an estimate of your accuracy; the faded part is how uncertain that estimate still is.
          A wide faded band means you have not answered enough questions on that topic for the number to
          mean much yet.
        </p>
      </div>

      {touched.length === 0 && <p className="text-slate-500">Nothing answered yet.</p>}

      {groups.map((group) => {
        const inGroup = rows.filter((r) => r.group === group && r.attempts > 0)
        if (inGroup.length === 0) return null
        return (
          <div key={group}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</h3>
            <div className="space-y-1.5">
              {inGroup
                .sort((a, b) => a.mean - b.mean)
                .map((r) => (
                  <div key={r.subtopic} className="flex items-center gap-3 text-sm">
                    <div className="w-52 shrink-0 truncate" title={r.label}>
                      {r.label}
                    </div>
                    <div className="relative h-2.5 flex-1 rounded-full bg-slate-200 dark:bg-slate-800">
                      <div
                        className="absolute h-2.5 rounded-full bg-sky-500/25"
                        style={{
                          left: `${Math.max(0, (r.mean - r.sd) * 100)}%`,
                          width: `${Math.min(100, r.sd * 200)}%`,
                        }}
                      />
                      <div
                        className="absolute top-1/2 h-3.5 w-1 -translate-y-1/2 rounded bg-sky-600"
                        style={{ left: `${r.mean * 100}%` }}
                      />
                    </div>
                    <div className="w-10 shrink-0 text-right tabular-nums text-slate-500">
                      {Math.round(r.mean * 100)}%
                    </div>
                    <div className="w-8 shrink-0 text-right text-xs tabular-nums text-slate-400">
                      {r.attempts}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------------ strategies

function Strategies() {
  const [list, setList] = useState<Array<{ title: string; tags: string[]; summary: string }> | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    api.strategies().then((r) => setList(r.strategies)).catch(() => setList([]))
  }, [])

  if (!list) return <p className="text-slate-500">Loading…</p>

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Strategies</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Written guidance, not generated. These come up automatically when you miss a related question.
        </p>
      </div>

      <div className="space-y-2">
        {list
          .slice()
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => setOpen(s.title)}
              className="block w-full rounded-lg border border-slate-300 px-4 py-3 text-left transition hover:border-slate-500 dark:border-slate-700"
            >
              <div className="font-medium">{s.title}</div>
              <div className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{s.summary}</div>
            </button>
          ))}
      </div>

      {open && <StrategyReader title={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
