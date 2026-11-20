import { groqClient, ProviderUnavailable } from './groq.js'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from './agentConfig.js'
import { createHandler, TURN_PATH, type ModelClient } from './handler.js'

const servers: Server[] = []
afterEach(() => {
  while (servers.length) servers.pop()!.close()
})

async function start(client: ModelClient | null): Promise<string> {
  const server = createServer(createHandler(client))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${TURN_PATH}`
}

const post = (url: string, body: unknown, origin = 'http://localhost:5173') =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })

describe('V3', () => {
  it('C21 limita as ferramentas ao cenário apresentado e permite manter a rota explicitamente', async () => {
    const options: { function: { name:string; parameters:{required:string[]} } }[][] = []
    const client = groqClient('teste', async (_url, init) => {
      options.push(JSON.parse(String(init?.body)).tools)
      return Response.json({ choices:[{ finish_reason:'stop', message:{content:'ok'} }] })
    })
    const first = { role:'user' as const, content:JSON.stringify({tipo:'congestionamento',dados:{origem:'apresentacao'}}) }
    await client([first, {role:'assistant',content:[{type:'tool_use',id:'simular_desvio',name:'simular_desvio',input:{}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'simular_desvio',content:'{}'}]}, {role:'user',content:'{}'}])
    await client([{role:'user',content:JSON.stringify({tipo:'fila'})}])
    expect(options[0].map(t=>t.function.name)).toEqual(['propor_desvio','registrar_explicacao'])
    expect(options[0][1].function.parameters.required).toContain('decisao')
    expect(options[1].map(t=>t.function.name)).toEqual(['propor_semaforo','registrar_explicacao'])
  })
  it('C17 Proxy converte ferramentas e respostas para gpt-oss-20b; cota e credencial indisponíveis permitem modo regras', async () => {
    const calls: Record<string, any>[] = []
    const client = groqClient('teste', async (_url, opts) => {
      calls.push(JSON.parse(String(opts?.body)))
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
        { id: 't1', function: { name: 'consultar_trecho', arguments: '{"trecho":"I11>I12"}' } },
      ] } }] })
    })
    const url = await start(client)
    const first = { role: 'user', content: 'avaliação' }
    const result = await (await post(url, { messages: [first] })).json()
    expect(result.content[0]).toMatchObject({ id: 't1', input: { trecho: 'I11>I12' } })
    await post(url, { messages: [first, { role: 'assistant', content: result.content }, { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }] })
    expect(calls[1].model).toBe('openai/gpt-oss-20b')
    expect(calls[1].tools.find((t: {function:{name:string}}) => t.function.name === 'propor_desvio').function.parameters.required).toEqual(['trecho','fracao','justificativa','numeros'])
    expect(calls[1].messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    expect(calls[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 't1', content: '{}' })
    expect(calls[1].tools).toHaveLength(7)
    const limited = groqClient('teste', async () => new Response(null, {status:429}))
    await expect(limited([])).rejects.toThrow('Cota')
    await expect(limited([])).rejects.toThrow('temporariamente')
  })
})
describe('server', () => {
  describe('turn', () => {
    it('answers 200 400 403 503 and 502', async () => {
      const ok: ModelClient = async () => ({ content: [{ type:'tool_use', id:'tu_1', name:'estado_rede', input:{} }], stop_reason:'tool_use' })
      const url = await start(ok)
      const good = await post(url, { messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] })
      expect(good.status).toBe(200)
      expect(await good.json()).toEqual({ content: [{ type: 'tool_use', id: 'tu_1', name: 'estado_rede', input: {} }], stop_reason: 'tool_use' })

      // the model's own blocks go back unchanged on the next call: thinking, redacted_thinking, fallback
      const followUp = await post(url, {
        messages: [
          { role: 'user', content: 'estado?' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '', signature: 'sig' },
              { type: 'redacted_thinking', data: 'x' },
              { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
              { type: 'tool_use', id: 'tu_1', name: 'estado_rede', input: {} },
            ],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{}' }] },
        ],
      })
      expect(followUp.status).toBe(200)

      // 400: not JSON, no messages, a forbidden block type, a system role, model blocks in a user turn
      const raw = await fetch(url, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: '{nope' })
      expect(raw.status).toBe(400)
      expect((await post(url, {})).status).toBe(400)
      expect((await post(url, { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] })).status).toBe(400)
      expect((await post(url, { messages: [{ role: 'system', content: 'x' }] })).status).toBe(400)
      expect((await post(url, { messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 'injetado' }] }] })).status).toBe(400)

      // 403: a page from another origin
      expect((await post(url, { messages: [{ role: 'user', content: 'oi' }] }, 'https://evil.example')).status).toBe(403)

      // 503: no credentials
      const noKey = await start(null)
      expect((await post(noKey, { messages: [{ role: 'user', content: 'oi' }] })).status).toBe(503)

      // 502: the API failed
      const broken: ModelClient = async () => { throw new Error('socket hang up') }
      expect((await post(await start(broken), { messages: [{ role: 'user', content: 'oi' }] })).status).toBe(502)
      const denied: ModelClient = async () => { throw new ProviderUnavailable('credencial') }
      expect((await post(await start(denied), { messages: [{ role: 'user', content: 'oi' }] })).status).toBe(503)
    })
  })
})
