/** Talking to the local server. Everything here goes to http://localhost, same machine. */

export type PublicQuestion = {
  id: string
  section: string
  subtopic: string
  subtopicLabel: string
  group: string
  format: 'mc' | 'ms' | 'ne' | 'qc' | 'tc' | 'se' | 'rc'
  difficulty: number
  mode: 'drill' | 'review'
  stem: string
  passage?: string
  quantityA?: string
  quantityB?: string
  options?: string[]
  blanks?: Array<{ options: string[] }>
  chooseExactly?: number
  numericEntry?: boolean
}

export type AnswerResponse =
  | { kind: 'choice'; indices: number[] }
  | { kind: 'blanks'; indices: number[] }
  | { kind: 'numeric'; value: string }

export type ErrorTag = { id: string; label: string; hint: string; strategies: string[] }

export type GradeResult = {
  attemptId: number
  correct: boolean
  correctIndices?: number[]
  correctValue?: number
  explanation: string
  errorTags: ErrorTag[]
}

export type Coaching = { diagnosis: string; errorTag: string; nextTime: string; cached: boolean }

export type Status = {
  budget: { used: number; limit: number; remaining: number; exhausted: boolean }
  buffer: { running: boolean; ready: number; lastError: string | null }
  ready: { quant: number; verbal: number }
  claude: { path: string | null; error: string | null; model: string }
  billingOverridesIgnored: string[]
}

export type MasteryRow = {
  subtopic: string
  label: string
  group: string
  section: string
  mean: number
  sd: number
  attempts: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`the server replied with something unreadable: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `request failed (${res.status})`
    throw new Error(message)
  }
  return body as T
}

export const api = {
  status: () => request<Status>('/api/status'),
  mastery: () => request<{ mastery: MasteryRow[] }>('/api/mastery'),

  startSession: (section: string) =>
    request<{ sessionId: string; section: string }>('/api/session', {
      method: 'POST',
      body: JSON.stringify({ section }),
    }),

  next: (sessionId: string) => request<{ question: PublicQuestion }>(`/api/session/${sessionId}/next`),

  answer: (sessionId: string, questionId: string, response: AnswerResponse, seconds: number) =>
    request<GradeResult>(`/api/session/${sessionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ questionId, response, seconds }),
    }),

  tag: (attemptId: number, tag: string) =>
    request<{ ok: true }>(`/api/attempt/${attemptId}/tag`, {
      method: 'POST',
      body: JSON.stringify({ tag }),
    }),

  coach: (questionId: string, response: AnswerResponse) =>
    request<Coaching>('/api/coach', {
      method: 'POST',
      body: JSON.stringify({ questionId, response }),
    }),

  strategies: () => request<{ strategies: Array<{ title: string; tags: string[]; summary: string }> }>('/api/strategies'),
  strategy: (title: string) =>
    request<{ title: string; markdown: string }>(`/api/strategies/${encodeURIComponent(title)}`),
}
