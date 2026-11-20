import type { IncomingMessage, ServerResponse } from 'node:http'
import { groqClient, ProviderUnavailable, type TurnMessage } from './groq.js'

export const TURN_PATH = '/api/agente/turno'
/**
 * Blocks a turn may carry: the page's text and tool results, and everything the model returned in
 * an assistant turn, which must go back unchanged - claude-opus-5-5 always thinks, so its replies
 * carry thinking blocks, and server-side fallbacks add fallback blocks.
 */
const USER_BLOCKS = new Set(['text', 'tool_result'])
const ASSISTANT_BLOCKS = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking', 'fallback'])
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

export type ModelClient = ReturnType<typeof groqClient>

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Only user/assistant turns made of text, tool_use and tool_result blocks. */
function validMessages(body: unknown): TurnMessage[] | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { messages?: unknown }).messages)) return null
  const messages = (body as { messages: unknown[] }).messages
  if (messages.length === 0 || messages.length > 40) return null
  for (const m of messages) {
    if (!m || typeof m !== 'object') return null
    const { role, content } = m as { role?: unknown; content?: unknown }
    if (role !== 'user' && role !== 'assistant') return null
    if (typeof content === 'string') continue
    if (!Array.isArray(content)) return null
    const allowed = role === 'user' ? USER_BLOCKS : ASSISTANT_BLOCKS
    for (const b of content) {
      if (!b || typeof b !== 'object' || !allowed.has((b as { type?: string }).type ?? '')) return null
    }
  }
  return messages as TurnMessage[]
}

/**
 * POST /api/agente/turno: one model call for the agent loop that runs in the page. The system
 * prompt, the tools and the model are fixed here; the key never reaches the page.
 * 400 bad body, 403 not the local page, 503 no credentials, 502 the API failed.
 */
export function createHandler(client: ModelClient | null) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' || req.url !== TURN_PATH) return send(res, 404, { erro: 'rota desconhecida' })
    const origin = req.headers.origin
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return send(res, 403, { erro: 'origem não permitida' })
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      return send(res, 400, { erro: 'JSON inválido' })
    }
    const messages = validMessages(body)
    if (!messages) return send(res, 400, { erro: 'mensagens inválidas' })
    if (!client) return send(res, 503, { erro: 'sem credencial da API; use o modo sem LLM' })
    try {
      return send(res, 200, await client(messages))
    } catch (error) {
      if (error instanceof ProviderUnavailable) return send(res, 503, { erro: error.message })
      return send(res, 502, { erro: 'falha ao chamar a API' })
    }
  }
}

/** A client when credentials can be resolved, null otherwise (the page then runs without the LLM). */
export function clientFromEnvironment(): ModelClient | null {
  return process.env.GROQ_API_KEY ? groqClient(process.env.GROQ_API_KEY) : null
}
