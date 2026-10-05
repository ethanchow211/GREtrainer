import { useMemo } from 'react'
import katex from 'katex'
import { splitMath } from './math-split.ts'
import { renderText } from './text-format.ts'

/**
 * Renders text with mathematics embedded in it.
 *
 * Questions arrive as prose with LaTeX between dollar signs, and standalone
 * equations between double dollar signs. The splitting is in math-split.ts, which
 * is pure and tested; this component only turns the pieces into HTML.
 */

type Props = {
  children: string
  className?: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode })
  } catch {
    // A malformed expression should show as written rather than break the page.
    return escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`)
  }
}

export function MathText({ children, className }: Props) {
  const html = useMemo(() => {
    return splitMath(children ?? '')
      .map((seg) => {
        if (seg.kind === 'text') return renderText(seg.text)
        if (seg.kind === 'inline') return renderTex(seg.tex, false)
        // A display equation gets its own centred block, the way it would be set
        // in a textbook -- that is why the generator reached for $$ in the first place.
        return `<span class="math-display">${renderTex(seg.tex, true)}</span>`
      })
      .join('')
  }, [children])

  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
