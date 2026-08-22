import { useMemo } from 'react'
import katex from 'katex'

/**
 * Renders text that contains mathematics written between dollar signs.
 *
 * Questions come back as prose with LaTeX embedded, like
 *   "If $x^2 = 16$ and $x < 0$, what is $\frac{x}{2}$?"
 * Plain text would make quant close to unreadable, so anything between single
 * dollar signs is handed to KaTeX and the rest is left alone.
 */

type Props = {
  children: string
  className?: string
}

type Segment = { math: boolean; text: string }

function split(source: string): Segment[] {
  const segments: Segment[] = []
  let rest = source
  // A dollar sign preceded by a backslash is a literal dollar (a price), not maths.
  const pattern = /(?<!\\)\$([^$]+?)(?<!\\)\$/

  for (;;) {
    const match = pattern.exec(rest)
    if (!match || match.index === undefined) break
    if (match.index > 0) segments.push({ math: false, text: rest.slice(0, match.index) })
    segments.push({ math: true, text: match[1] as string })
    rest = rest.slice(match.index + match[0].length)
  }
  if (rest) segments.push({ math: false, text: rest })
  return segments
}

export function MathText({ children, className }: Props) {
  const html = useMemo(() => {
    return split(children ?? '')
      .map((seg) => {
        if (!seg.math) {
          return escapeHtml(seg.text).replace(/\\\$/g, '$').replace(/\n/g, '<br />')
        }
        try {
          return katex.renderToString(seg.text, { throwOnError: false, displayMode: false })
        } catch {
          // A malformed expression should show as written rather than break the page.
          return escapeHtml(`$${seg.text}$`)
        }
      })
      .join('')
  }, [children])

  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
