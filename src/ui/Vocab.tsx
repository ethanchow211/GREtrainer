import { useCallback, useEffect, useState } from 'react'
import { api, type VocabCard, type VocabStats } from './api.ts'

/**
 * The vocabulary deck.
 *
 * Words arrive on their own: every word offered by a Text Completion or Sentence
 * Equivalence question you missed goes into the deck, right and wrong options alike.
 * The trap words are usually the ones worth learning.
 *
 * Recall is tested in the direction the test uses — see the word, remember the
 * meaning. Reading a definition and nodding is not studying, so the definition stays
 * hidden until you commit.
 */

export function Vocab({ onError }: { onError: (e: string | null) => void }) {
  const [cards, setCards] = useState<VocabCard[] | null>(null)
  const [stats, setStats] = useState<VocabStats | null>(null)
  const [at, setAt] = useState(0)
  const [revealed, setRevealed] = useState(false)

  const load = useCallback(() => {
    api
      .vocabDue()
      .then((r) => {
        setCards(r.cards)
        setStats(r.stats)
        setAt(0)
        setRevealed(false)
      })
      .catch((e) => onError((e as Error).message))
  }, [onError])

  useEffect(load, [load])

  async function rate(knew: 'no' | 'hard' | 'yes'): Promise<void> {
    const card = cards?.[at]
    if (!card) return
    try {
      const r = await api.reviewVocab(card.word, knew)
      setStats(r.stats)
    } catch (e) {
      onError((e as Error).message)
    }
    setRevealed(false)
    setAt((i) => i + 1)
  }

  if (!cards || !stats) return <p className="text-slate-500">Loading…</p>

  const header = (
    <div className="flex flex-wrap gap-4 text-xs text-slate-500">
      <span>{stats.total} words collected</span>
      <span>{stats.due} due now</span>
      <span>{stats.learned} settling in</span>
      {stats.pending > 0 && (
        <span title="These are waiting on a definition, which is written in batches in the background">
          {stats.pending} awaiting definitions
        </span>
      )}
    </div>
  )

  if (stats.total === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Vocabulary</h2>
        <p className="text-slate-600 dark:text-slate-400">
          The deck is empty, and it fills itself. Every word offered by a Text Completion or Sentence
          Equivalence question you get wrong is added here automatically — the wrong options included, since
          those are usually the words that made the question hard.
        </p>
        <p className="text-sm text-slate-500">Drill some verbal questions and come back.</p>
      </div>
    )
  }

  const card = cards[at]

  if (!card) {
    return (
      <div className="space-y-5">
        <h2 className="text-xl font-semibold tracking-tight">Vocabulary</h2>
        {header}
        <p className="text-slate-600 dark:text-slate-400">
          {cards.length > 0
            ? 'Nothing more due right now. Words come back on a widening schedule as you keep getting them right.'
            : stats.pending > 0
              ? 'Words are collected but their definitions are still being written. Check back shortly.'
              : 'Nothing due right now.'}
        </p>
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
        >
          Check again
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Vocabulary</h2>
        <span className="text-xs text-slate-500">
          {at + 1} of {cards.length} due
        </span>
      </div>
      {header}

      <div className="rounded-xl border border-slate-300 p-8 text-center dark:border-slate-700">
        <div className="text-3xl font-semibold tracking-tight">{card.word}</div>

        {!revealed ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            autoFocus
            className="mt-8 rounded-lg bg-slate-900 px-5 py-2.5 font-medium text-white dark:bg-slate-100 dark:text-slate-900"
          >
            Show meaning
          </button>
        ) : (
          <div className="mt-6 space-y-5">
            <p className="whitespace-pre-line text-left text-[15px] leading-relaxed">{card.definition}</p>

            <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
              <p className="mb-3 text-xs uppercase tracking-wide text-slate-500">Did you know it?</p>
              <div className="flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => void rate('no')}
                  className="rounded-lg border border-rose-400 px-4 py-2 text-sm hover:bg-rose-50 dark:hover:bg-rose-950/30"
                >
                  No
                </button>
                <button
                  type="button"
                  onClick={() => void rate('hard')}
                  className="rounded-lg border border-amber-400 px-4 py-2 text-sm hover:bg-amber-50 dark:hover:bg-amber-950/30"
                >
                  Roughly
                </button>
                <button
                  type="button"
                  onClick={() => void rate('yes')}
                  className="rounded-lg border border-emerald-400 px-4 py-2 text-sm hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                >
                  Yes
                </button>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Answer honestly. &ldquo;Roughly&rdquo; brings it back sooner than &ldquo;yes&rdquo;, which is
                the point.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
