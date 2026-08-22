import { useEffect, useState } from 'react'
import { marked } from 'marked'
import { api } from './api.ts'

/**
 * Reads one strategy page.
 *
 * These pages are hand-written markdown in content/strategies, shipped with the app
 * rather than generated, so the guidance is consistent and readable offline. They
 * surface automatically after a miss, based on which error you tagged.
 */

type Props = {
  title: string
  onClose: () => void
}

/** Obsidian-style callouts render as plain blockquotes, so give them a label. */
function dressCallouts(markdown: string): string {
  return markdown.replace(/^> \[!(\w+)\]\s*$/gm, (_m, kind: string) => {
    const label = kind.charAt(0).toUpperCase() + kind.slice(1)
    return `> **${label}**  `
  })
}

export function StrategyReader({ title, onClose }: Props) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    setError(null)
    api
      .strategy(title)
      .then(async (r) => {
        if (cancelled) return
        // Strip the YAML frontmatter; it is metadata for the app, not for reading.
        const body = r.markdown.replace(/^---\n[\s\S]*?\n---\n/, '')
        setHtml(await marked.parse(dressCallouts(body)))
      })
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [title])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div className="h-fit w-full max-w-2xl rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1 text-sm dark:border-slate-700"
          >
            Close
          </button>
        </div>

        {error && <p className="text-sm text-rose-600">{error}</p>}
        {!html && !error && <p className="text-slate-500">Loading…</p>}
        {html && <div className="strategy-prose" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  )
}
