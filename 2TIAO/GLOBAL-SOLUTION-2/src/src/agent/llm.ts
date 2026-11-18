/** A content block of the agent conversation (the shapes the proxy accepts and returns). */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /** Blocks the page does not read (thinking, fallback, ...): sent back to the model unchanged. */
  | { type: 'thinking' | 'redacted_thinking' | 'fallback'; [field: string]: unknown }

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string | Block[]
}

export interface LlmResponse {
  content: Block[]
  stop_reason: string
}

/** One call to the model through the proxy. */
export type LlmTurn = (messages: AgentMessage[]) => Promise<LlmResponse>

/** The model can't be reached now: no credential (503), API failure (502), timeout or network. */
export class LlmUnavailable extends Error {}

/** The proxy refused the request itself (400): a bug in what the page sent, not an outage. */
export class LlmRequestError extends Error {}

export const TURN_URL = '/api/agente/turno'
export const TURN_TIMEOUT_MS = 30_000

export function proxyLlm(url = TURN_URL, timeoutMs = TURN_TIMEOUT_MS, fetchFn: typeof fetch = fetch): LlmTurn {
  return async (messages) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: abort.signal,
      })
      if (res.status === 400) throw new LlmRequestError(`proxy 400: ${await res.text()}`)
      if (!res.ok) throw new LlmUnavailable(`proxy ${res.status}`)
      const body = (await res.json()) as LlmResponse
      if (!Array.isArray(body.content) || typeof body.stop_reason !== 'string') throw new LlmUnavailable('resposta inválida')
      return body
    } catch (error) {
      if (error instanceof LlmUnavailable || error instanceof LlmRequestError) throw error
      throw new LlmUnavailable(error instanceof Error ? error.message : 'falha de rede')
    } finally {
      clearTimeout(timer)
    }
  }
}
