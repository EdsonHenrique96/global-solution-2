import { describe, expect, it } from 'vitest'
import { diversionSize } from '../decision/DiversionController'
import { Simulation } from '../decision/Simulation'
import { SimulationEngine } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { AgentLog, LOG_SIZE } from './AgentLog'
import { AgentRunner, NOTIFICATIONS_TOPIC } from './AgentRunner'
import { LlmUnavailable, type LlmResponse, type LlmTurn } from './llm'
import { decideDiversion, decideGreen } from './policy'
import { TOOL_NAMES } from './tools'

type Block = LlmResponse['content'][number]
const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: 'tool_use', id, name, input })
const text = (t: string): Block => ({ type: 'text', text: t })

/** A model that plays a script: one response per call; then end_turn. */
function scripted(steps: LlmResponse[]): LlmTurn & { calls: number; seen: unknown[][] } {
  const fn = (async (messages) => {
    fn.calls += 1
    fn.seen.push(JSON.parse(JSON.stringify(messages)))
    return steps.shift() ?? { content: [text('ok')], stop_reason: 'end_turn' }
  }) as LlmTurn & { calls: number; seen: unknown[][] }
  fn.calls = 0
  fn.seen = []
  return fn
}

function setup(llm: LlmTurn, rate = 0) {
  const transport = new FakeTransport(true)
  const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: rate, noisePct: 0 }), transport, agentControl: true })
  sim.start()
  const runner = new AgentRunner({ sim, llm, transport })
  return { sim, runner, transport }
}

async function runFor(sim: Simulation, runner: AgentRunner, ms: number) {
  const end = sim.engine.getState().timeMs + ms
  while (sim.engine.getState().timeMs < end) {
    sim.tick()
    runner.tick()
    await runner.idle()
  }
}

describe('agent', () => {
  describe('runner', () => {
    it('runs a turn every 30 s and on a new alert until end_turn with at most 6 model calls', async () => {
      // the model would keep calling tools forever: the turn stops at 6 calls
      let n = 0
      const greedy = (async () => {
        n += 1
        return { content: [toolUse(`t${n}`, 'estado_rede', {})], stop_reason: 'tool_use' }
      }) as LlmTurn
      const { sim, runner } = setup(greedy)
      await runFor(sim, runner, 30_000)
      expect(runner.turns).toBe(1)
      expect(n).toBe(6)

      // a normal turn: tool, tool, end_turn; the results go back with the tool_use ids
      // claude-opus-5-5 always thinks: its thinking blocks must go back unchanged
      const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' } as Block
      const llm = scripted([
        { content: [thinking, toolUse('a', 'estado_rede', {})], stop_reason: 'tool_use' },
        { content: [toolUse('b', 'registrar_explicacao', { texto: 'Nada a mudar.' })], stop_reason: 'tool_use' },
        { content: [text('fim')], stop_reason: 'end_turn' },
      ])
      const s2 = setup(llm)
      await runFor(s2.sim, s2.runner, 29_900)
      expect(s2.runner.turns).toBe(0)
      await runFor(s2.sim, s2.runner, 100)
      expect(s2.runner.turns).toBe(1)
      expect(llm.calls).toBe(3)
      const second = llm.seen[1] as { role: string; content: unknown[] }[]
      expect(second[1]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, toolUse('a', 'estado_rede', {})] })
      const last = llm.seen[2] as { role: string; content: { type: string; tool_use_id?: string }[] }[]
      expect(last[last.length - 1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'b' })
      // a new alert starts a turn before the next 30 s mark
      await runFor(s2.sim, s2.runner, 5_000)
      expect(s2.runner.turns).toBe(1)
      s2.sim.engine.addBlockage('central', 500)
      await runFor(s2.sim, s2.runner, 100)
      expect(s2.runner.turns).toBe(2)
      await runFor(s2.sim, s2.runner, 24_900) // the 60 s mark
      expect(s2.runner.turns).toBe(3)
    })
  })

  describe('tools', () => {
    it('exposes four tools and sizes diversions with diversionSize', async () => {
      expect([...TOOL_NAMES]).toEqual(['estado_rede', 'propor_desvio', 'propor_semaforo', 'registrar_explicacao'])
      const llm = scripted([
        { content: [toolUse('a', 'estado_rede', {})], stop_reason: 'tool_use' },
        // the model tries to set p itself: ignored
        { content: [toolUse('b', 'propor_desvio', { de: 'central', para: 'norte', justificativa: 'teste', p: 0.99, n: 9999 })], stop_reason: 'tool_use' },
        { content: [text('fim')], stop_reason: 'end_turn' },
      ])
      const { sim, runner } = setup(llm, 15)
      await runFor(sim, runner, 30_000)
      const state = JSON.parse((llm.seen[1] as { content: { content: string }[] }[]).at(-1)!.content[0].content)
      expect(Object.keys(state).sort()).toEqual(['alertas', 'desvio', 'filas', 'metricas', 'rotas', 'tempoS'])
      const toolResult = (llm.seen[2] as { content: { content: string }[] }[]).at(-1)!.content[0].content
      const routes = sim.capacity.routes()
      const demand = sim.demand()
      const expected = diversionSize(demand.central, routes.central.fluxo, routes.norte.folga ?? 0)
      expect(JSON.parse(toolResult)).toMatchObject({ n: expected.n, p: expected.p })
      // an unknown tool gets an error result, not a crash
      const odd = scripted([{ content: [toolUse('x', 'apagar_tudo', {})], stop_reason: 'tool_use' }])
      const s3 = setup(odd)
      await runFor(s3.sim, s3.runner, 30_000)
      const err = (odd.seen[1] as { content: { is_error?: boolean }[] }[]).at(-1)!.content[0]
      expect(err.is_error).toBe(true)
    })
  })

  describe('log', () => {
    it('records explanations newest first and keeps the last 50', async () => {
      const log = new AgentLog()
      for (let i = 0; i < 60; i++) log.add(i * 1000, 'agente', `e${i}`)
      expect(log.entries()).toHaveLength(LOG_SIZE)
      expect(LOG_SIZE).toBe(50)
      expect(log.entries()[0]).toEqual({ at: 59_000, origem: 'agente', texto: 'e59' })
      expect(log.entries()[49].texto).toBe('e10')
      // through the tool
      const llm = scripted([{ content: [toolUse('a', 'registrar_explicacao', { texto: 'Central livre; nada a fazer.' })], stop_reason: 'tool_use' }])
      const { sim, runner } = setup(llm)
      await runFor(sim, runner, 30_000)
      expect(runner.log.entries()[0]).toEqual({ at: 30_000, origem: 'agente', texto: 'Central livre; nada a fazer.' })
    })
  })

  describe('autonomy', () => {
    it('applies diversions up to p 0.3 and cards the larger ones', async () => {
      expect(decideDiversion(0.25)).toBe('aplicar')
      expect(decideDiversion(0.3)).toBe('aplicar')
      expect(decideDiversion(0.31)).toBe('aprovar')
      expect(decideDiversion(0.4)).toBe('aprovar')
      // in a run: the agent proposes; small p applies at once, large p waits as a card
      const { sim, runner } = setup(scripted([]), 15)
      runner.applyProposal({ tipo: 'desvio', de: 'central', para: 'norte', n: 75, p: 0.25, justificativa: 'via lenta' })
      expect(sim.engine.getState().diversion).toEqual({ from: 'central', to: 'norte', fraction: 0.25 })
      runner.applyProposal({ tipo: 'desvio', de: 'central', para: 'sul', n: 120, p: 0.4, justificativa: 'acidente' })
      expect(sim.engine.getState().diversion).toEqual({ from: 'central', to: 'norte', fraction: 0.25 })
      const [card] = runner.queue.pending()
      expect(card).toMatchObject({ estado: 'aguardando', acao: { tipo: 'desvio', de: 'central', para: 'sul', n: 120, p: 0.4, justificativa: 'acidente' } })
      // p 0: nothing to divert, nothing applied
      sim.engine.setDiversion(null)
      runner.applyProposal({ tipo: 'desvio', de: 'central', para: 'norte', n: 0, p: 0, justificativa: 'sem folga' })
      expect(sim.engine.getState().diversion).toBeNull()
      // "Desvio parcial" off: no diversion is applied or carded
      sim.setDiversionEnabled(false)
      runner.applyProposal({ tipo: 'desvio', de: 'central', para: 'norte', n: 30, p: 0.1, justificativa: 'x' })
      runner.applyProposal({ tipo: 'desvio', de: 'central', para: 'norte', n: 300, p: 0.5, justificativa: 'y' })
      expect(sim.engine.getState().diversion).toBeNull()
      expect(runner.queue.pending()).toHaveLength(1)
      expect(runner.log.entries()[0].texto).toMatch(/desvio parcial está desligado/)
    })

    it('applies greens of 10 to 30 s cards 31 to 60 s and refuses the rest', async () => {
      expect([10, 30, 31, 60, 9, 61].map(decideGreen)).toEqual(['aplicar', 'aplicar', 'aprovar', 'aprovar', 'recusar', 'recusar'])
      const { sim, runner } = setup(scripted([]))
      sim.engine.setAdaptiveSignals(true)
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I1', verdeS: 25, justificativa: 'fila' })
      // I1 turns green at 43 s: that green lasts 25 s
      await runFor(sim, runner, 43_000)
      const i1 = () => sim.engine.getState().lights.find((l) => l.intersectionId === 'I1')!
      expect(i1().phase).toBe('verde')
      expect(i1().remainingS).toBeCloseTo(25, 1)
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I2', verdeS: 45, justificativa: 'fila longa' })
      expect(runner.queue.pending()).toHaveLength(1)
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I2', verdeS: 90, justificativa: 'absurdo' })
      expect(runner.queue.pending()).toHaveLength(1)
      expect(runner.log.entries()[0].texto).toMatch(/recusad/)
    })
  })

  describe('approval', () => {
    it('applies on approve logs a rejection and expires after 120 s', async () => {
      const { sim, runner } = setup(scripted([]), 15)
      runner.applyProposal({ tipo: 'desvio', de: 'central', para: 'sul', n: 120, p: 0.4, justificativa: 'acidente' })
      const [a] = runner.queue.pending()
      runner.approve(a.id)
      expect(sim.engine.getState().diversion).toEqual({ from: 'central', to: 'sul', fraction: 0.4 })
      expect(runner.queue.get(a.id)!.estado).toBe('aplicada')
      expect(runner.log.entries()[0]).toMatchObject({ origem: 'operador', texto: expect.stringMatching(/aprovad/) })
      runner.approve(a.id) // only once
      expect(runner.log.entries().filter((e) => e.origem === 'operador')).toHaveLength(1)

      runner.applyProposal({ tipo: 'desvio', de: 'norte', para: 'central', n: 90, p: 0.45, justificativa: 'x' })
      const [b] = runner.queue.pending()
      runner.reject(b.id)
      expect(sim.engine.getState().diversion).toEqual({ from: 'central', to: 'sul', fraction: 0.4 })
      expect(runner.queue.get(b.id)!.estado).toBe('rejeitada')
      expect(runner.log.entries()[0]).toMatchObject({ origem: 'operador', texto: expect.stringMatching(/rejeitad/) })

      runner.applyProposal({ tipo: 'desvio', de: 'sul', para: 'norte', n: 90, p: 0.5, justificativa: 'y' })
      const [c] = runner.queue.pending()
      await runFor(sim, runner, 119_900)
      expect(runner.queue.get(c.id)!.estado).toBe('aguardando')
      await runFor(sim, runner, 100)
      expect(runner.queue.get(c.id)!.estado).toBe('expirada')
      runner.approve(c.id) // too late
      expect(sim.engine.getState().diversion?.from).not.toBe('sul')

      // a green card approved while signal control is off is not applied, and says so
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I1', verdeS: 45, justificativa: 'fila' })
      const [g] = runner.queue.pending()
      runner.approve(g.id)
      expect(runner.queue.get(g.id)!.estado).toBe('nao-aplicada')
      expect(runner.log.entries()[0].texto).toMatch(/aprovado, mas não aplicado/)
      // a diversion card approved after "Desvio parcial" was turned off is not applied either
      runner.applyProposal({ tipo: 'desvio', de: 'norte', para: 'sul', n: 90, p: 0.6, justificativa: 'z' })
      const [d] = runner.queue.pending()
      sim.setDiversionEnabled(false)
      runner.approve(d.id)
      expect(runner.queue.get(d.id)!.estado).toBe('nao-aplicada')
      expect(sim.engine.getState().diversion).toBeNull()
    })
  })

  describe('notifications', () => {
    it('publishes one aggregated notification per window with diverted cars', async () => {
      const { sim, runner, transport } = setup(scripted([]), 120)
      const seen: Record<string, unknown>[] = []
      transport.subscribe(NOTIFICATIONS_TOPIC, (_t, p) => seen.push(JSON.parse(p)))
      const published = () => transport.published.filter((m) => m.topic === NOTIFICATIONS_TOPIC)
      await runFor(sim, runner, 10_000)
      expect(seen).toHaveLength(0) // nothing diverted yet
      runner.applyProposal({ tipo: 'desvio', de: 'central', para: 'norte', n: 300, p: 0.3, justificativa: 'teste' })
      const before = sim.engine.getState().divertedTotal
      await runFor(sim, runner, 10_000)
      const diverted = sim.engine.getState().divertedTotal - before
      expect(diverted).toBeGreaterThan(0)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toEqual({
        ts: 20_000,
        canal: 'app-de-mapa-simulado',
        de: 'central',
        para: 'norte',
        quantidade: diverted,
        mensagem: expect.stringContaining('Norte'),
      })
      expect(runner.notified).toBe(diverted)
      expect(published()[0].options).toEqual({ qos: 0, retain: false })
    })
  })

  describe('fallback', () => {
    it('runs the rules without the LLM on 503 502 or timeout and returns to LLM mode', async () => {
      let down = true
      const llm = (async () => {
        if (down) throw new LlmUnavailable('503')
        return { content: [text('ok')], stop_reason: 'end_turn' }
      }) as LlmTurn
      const { sim, runner } = setup(llm, 15)
      await runFor(sim, runner, 30_000)
      expect(runner.mode).toBe('regra')
      expect(runner.log.entries()[0].origem).toBe('regra')
      // an accident in front of C2: the rules divert through the same autonomy policy
      sim.engine.addBlockage('central', 500)
      await runFor(sim, runner, 200_000)
      const ruleEntries = runner.log.entries().filter((e) => e.origem === 'regra')
      expect(ruleEntries.some((e) => /desvio/i.test(e.texto))).toBe(true)
      const applied = sim.engine.getState().diversion !== null || runner.queue.all().some((c) => c.acao.tipo === 'desvio')
      expect(applied).toBe(true)
      // the LLM is back: the next turn runs in LLM mode
      down = false
      await runFor(sim, runner, 30_000)
      expect(runner.mode).toBe('llm')
      // proxyLlm maps 503, 502 and timeouts to LlmUnavailable
      const { proxyLlm } = await import('./llm')
      for (const status of [503, 502]) {
        const f = proxyLlm('/x', 1000, (async () => new Response('{}', { status })) as typeof fetch)
        await expect(f([{ role: 'user', content: 'oi' }])).rejects.toBeInstanceOf(LlmUnavailable)
      }
      const slow = proxyLlm('/x', 20, ((_u: string, init?: RequestInit) =>
        new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch)
      await expect(slow([{ role: 'user', content: 'oi' }])).rejects.toBeInstanceOf(LlmUnavailable)
      // a 400 is the page's fault, not an outage: a distinct error, logged, and the rules still decide
      const { LlmRequestError } = await import('./llm')
      const bad = proxyLlm('/x', 1000, (async () => new Response('{"erro":"mensagens inválidas"}', { status: 400 })) as typeof fetch)
      await expect(bad([{ role: 'user', content: 'oi' }])).rejects.toBeInstanceOf(LlmRequestError)
      const refusing = (async () => {
        throw new LlmRequestError('proxy 400: mensagens inválidas')
      }) as LlmTurn
      const r = setup(refusing)
      await runFor(r.sim, r.runner, 30_000)
      const texts = r.runner.log.entries().map((e) => e.texto)
      expect(texts.some((t) => /recusado pelo proxy \(proxy 400/.test(t))).toBe(true)
      expect(texts.some((t) => /Regras/.test(t))).toBe(true)
      const ok = proxyLlm('/x', 1000, (async () => new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), { status: 200 })) as typeof fetch)
      await expect(ok([{ role: 'user', content: 'oi' }])).resolves.toEqual({ content: [], stop_reason: 'end_turn' })
    })
  })
})
