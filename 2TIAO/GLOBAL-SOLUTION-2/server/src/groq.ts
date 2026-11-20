import { MODEL, SYSTEM_PROMPT, TOOLS } from './agentConfig.js'

export interface TurnBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}
export interface TurnMessage { role: 'assistant' | 'user'; content: string | TurnBlock[] }
interface ToolCall { id: string; function: { name: string; arguments: string } }

function history(messages: TurnMessage[]) {
  const out: Record<string, unknown>[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const { role, content } of messages) {
    if (typeof content === 'string') {
      out.push({ role, content })
    } else if (role === 'assistant') {
      const calls = content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) },
      }))
      out.push({ role, content: content.filter(b => b.type === 'text').map(b => b.text).join('\n') || null,
        ...(calls.length && { tool_calls: calls }) })
    } else {
      for (const b of content) out.push(b.type === 'tool_result'
        ? { role: 'tool', tool_call_id: b.tool_use_id, content: b.content }
        : { role, content: b.text })
    }
  }
  return out
}

export class ProviderUnavailable extends Error {}

export function groqClient(key: string, request: typeof fetch = fetch) {
  let retryAt = 0
  return async (messages: TurnMessage[]) => {
    if (Date.now() < retryAt) throw new ProviderUnavailable('Cota temporariamente indisponível')
    const snapshot = messages.length === 4 && Array.isArray(messages[1]?.content)
      && messages[1].content.some(b => b.type === 'tool_use' && b.id === 'simular_desvio' && b.name === 'simular_desvio')
    let queueEvent = false
    if (messages.length === 1 && typeof messages[0].content === 'string') {
      try { queueEvent = JSON.parse(messages[0].content)?.tipo === 'fila' } catch { /* ordinary user text */ }
    }
    const tools = queueEvent ? TOOLS.filter(t => ['propor_semaforo','registrar_explicacao'].includes(t.name)) : snapshot ? TOOLS.filter(t => ['propor_desvio', 'propor_semaforo', 'registrar_explicacao'].includes(t.name)) : TOOLS
    const res = await request('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ model: MODEL, messages: history(messages), reasoning_effort: 'low',
        ...((snapshot || queueEvent) && { tool_choice: 'required' }),
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }),
    })
    if (res.status === 429) {
      const delay = Number(res.headers.get('retry-after'))
      retryAt = Date.now() + (delay > 0 ? delay : 60) * 1000
      throw new ProviderUnavailable('Cota do provedor atingida')
    }
    if ([401, 403].includes(res.status)) throw new ProviderUnavailable('Credencial recusada')
    if (!res.ok) throw new Error('Falha no provedor')
    const choice = (await res.json()).choices?.[0]
    const content: TurnBlock[] = []
    if (typeof choice?.message?.content === 'string') content.push({ type: 'text', text: choice.message.content })
    for (const call of (choice?.message?.tool_calls ?? []) as ToolCall[]) {
      const input = JSON.parse(call.function.arguments)
      if (!call.id || !call.function.name || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ferramenta inválida')
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
    }
    if (!content.length || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Resposta incompleta')
    return { content, stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' }
  }
}
