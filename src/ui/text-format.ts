/**
 * Render the small piece of Markdown that question text is allowed to use.
 *
 * Claude sometimes emphasizes a phrase with **double asterisks**. Pulling in a
 * full Markdown renderer for that one feature would make the question renderer
 * harder to reason about, so this deliberately supports bold text only. Every
 * character supplied by the model is escaped before it becomes HTML.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderText(text: string): string {
  let html = ''
  let position = 0

  while (position < text.length) {
    const opening = text.indexOf('**', position)
    if (opening === -1) {
      html += escapeHtml(text.slice(position))
      break
    }

    const closing = text.indexOf('**', opening + 2)
    if (closing === -1 || closing === opening + 2) {
      // Leave an unmatched or empty marker visible instead of guessing where
      // emphasis should end.
      html += escapeHtml(text.slice(position))
      break
    }

    html += escapeHtml(text.slice(position, opening))
    html += `<strong>${escapeHtml(text.slice(opening + 2, closing))}</strong>`
    position = closing + 2
  }

  return html.replace(/\n/g, '<br />')
}
