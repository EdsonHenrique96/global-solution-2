import { describe, expect, it } from 'vitest'
import { APPS_TOPIC } from '../apps/AppFleet'
import { Simulation } from '../decision/Simulation'
import { sortRoads } from '../render/roads'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { deliverMetrics, FakeTransport } from '../telemetry/testing'
import { AgentLog, LOG_SIZE } from './AgentLog'
import { AgentRunner } from './AgentRunner'
import { LlmUnavailable, type LlmResponse, type LlmTurn } from './llm'
import { decideDiversion, decideGreen } from './policy'
import { executeTool, TOOL_NAMES, WORST_SEGMENTS } from './tools'

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
  const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: rate }), transport, agentControl: true })
  sim.start()
  const runner = new AgentRunner({ sim, llm })
  return { sim, runner, transport }
}

const JAMMED = 'I12>I13'

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
      s2.sim.engine.addBlockage(JAMMED, 70)
      await runFor(s2.sim, s2.runner, 100)
      expect(s2.runner.turns).toBe(2)
      await runFor(s2.sim, s2.runner, 24_900) // the 60 s mark
      expect(s2.runner.turns).toBe(3)
    })
  })

  describe('tools', () => {
    it('exposes segment based tools and rejects invalid targets', () => {
      expect([...TOOL_NAMES]).toEqual(['estado_rede', 'propor_desvio', 'propor_semaforo', 'registrar_explicacao'])
      const { sim, runner } = setup(scripted([]), 30)
      for (let t = 0; t < 60_000; t += TICK_MS) sim.tick()
      const ctx = { sim, propose: (a: Parameters<typeof runner.applyProposal>[0]) => runner.applyProposal(a), explain: () => {} }
      const state = JSON.parse(executeTool('estado_rede', {}, ctx).content)
      expect(Object.keys(state).sort()).toEqual(['alertas', 'desvio', 'filas', 'metricas', 'motoristasComApp', 'pioresTrechos', 'tempoS'])
      expect(state.pioresTrechos).toHaveLength(WORST_SEGMENTS)
      const estimates = sim.capacity.snapshot()
      const worst = sortRoads(sim.capacity.segments.map((s) => ({ id: s.id, estado: estimates[s.id].estado, velocidade: estimates[s.id].velocidade })))
      expect(state.pioresTrechos.map((t: { trecho: string }) => t.trecho)).toEqual(worst.slice(0, WORST_SEGMENTS).map((r) => r.id))
      expect(Object.keys(state.filas)).toHaveLength(16)
      expect(state.filas.I11).toEqual({ H: expect.any(Number), V: expect.any(Number) })
      expect(state.motoristasComApp.total).toBe(sim.fleet.snapshot().total)

      const bad = (name: string, input: Record<string, unknown>) => executeTool(name, input, ctx)
      expect(bad('propor_desvio', { trecho: 'I9>I9', justificativa: 'x' })).toMatchObject({ is_error: true, content: expect.stringMatching(/trecho inválido/) })
      expect(bad('propor_desvio', { de: 'central', para: 'norte', justificativa: 'x' }).is_error).toBe(true)
      expect(bad('propor_semaforo', { intersecao: 'I5', fase: 'H', verde_s: 20, justificativa: 'x' }).is_error).toBe(true)
      expect(bad('propor_semaforo', { intersecao: 'I11', fase: 'X', verde_s: 20, justificativa: 'x' }).is_error).toBe(true)
      expect(bad('propor_semaforo', { intersecao: 'I11', fase: 'V', verde_s: 20, justificativa: 'x' }).is_error).toBeUndefined()
      expect(bad('propor_desvio', { trecho: JAMMED, justificativa: 'x' }).is_error).toBeUndefined()
      expect(bad('apagar_tudo', {}).is_error).toBe(true)
    })

    it('sizes a proposed diversion like the rerouter and applies the policy', () => {
      // no real cameras: only the injected metrics measure the block
      const transport = new FakeTransport(true)
      const sim = new Simulation({ engine: new SimulationEngine({ ratePerMinute: 0, cameras: [] }), transport, agentControl: true })
      sim.start()
      const runner = new AgentRunner({ sim, llm: scripted([]) })
      // the block crawls at 3 km/h with 8 cars on 140 m: flow 171 veh/h once learned
      const reading = (ts: number) => deliverMetrics(transport, JAMMED, ts, { k: 8 / 0.14, v: 3, ocupacao: 8 })
      reading(0)
      for (let t = 0; t < 10_100; t += TICK_MS) sim.tick()
      reading(sim.engine.getState().timeMs)
      sim.engine.addCar({ path: ['I11>I12', JAMMED, 'I13>I14'], app: 'waze', velocity: 0 })
      const ctx = { sim, propose: (a: Parameters<typeof runner.applyProposal>[0]) => runner.applyProposal(a), explain: () => {} }
      const propose = (demand: number) => {
        transport.deliver(APPS_TOPIC, JSON.stringify({ ts: 0, total: 1, porApp: {}, porTrecho: {}, demandaPorTrecho: { [JAMMED]: demand } }))
        const expected = sim.sizing(JAMMED)
        const out = JSON.parse(executeTool('propor_desvio', { trecho: JAMMED, justificativa: 'acidente', p: 0.99, n: 9999 }, ctx).content)
        expect(out).toMatchObject({ n: expected.n, p: expected.p, candidatos: expected.evaluations.length })
        return out
      }
      // small excess: p <= 0.3 applies at once
      const small = propose(230)
      expect(small.p).toBeGreaterThan(0)
      expect(small.p).toBeLessThanOrEqual(0.3)
      expect(small.resultado).toMatch(/^aplicado/)
      expect(sim.active).toEqual({ trecho: JAMMED, p: small.p, mode: 'parcial' })
      // large excess: p above 0.3 waits for the operator
      const large = propose(600)
      expect(large.p).toBeGreaterThan(0.3)
      expect(large.resultado).toMatch(/aguardando aprovação/)
      expect(runner.queue.pending()[0].acao).toMatchObject({ tipo: 'desvio', trecho: JAMMED, p: large.p })
      expect(sim.active?.p).toBe(small.p)
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
      runner.applyProposal({ tipo: 'desvio', trecho: JAMMED, n: 75, p: 0.25, justificativa: 'via lenta' })
      expect(sim.active).toEqual({ trecho: JAMMED, p: 0.25, mode: 'parcial' })
      runner.applyProposal({ tipo: 'desvio', trecho: 'I22>I23', n: 120, p: 0.4, justificativa: 'acidente' })
      expect(sim.active).toEqual({ trecho: JAMMED, p: 0.25, mode: 'parcial' })
      const [card] = runner.queue.pending()
      expect(card).toMatchObject({ estado: 'aguardando', acao: { tipo: 'desvio', trecho: 'I22>I23', n: 120, p: 0.4, justificativa: 'acidente' } })
      // p 0: nothing to divert, nothing applied
      sim.setActiveDiversion(null)
      runner.applyProposal({ tipo: 'desvio', trecho: JAMMED, n: 0, p: 0, justificativa: 'sem folga' })
      expect(sim.active).toBeNull()
      // "Desvio parcial" off: no diversion is applied or carded
      sim.setDiversionEnabled(false)
      runner.applyProposal({ tipo: 'desvio', trecho: JAMMED, n: 30, p: 0.1, justificativa: 'x' })
      runner.applyProposal({ tipo: 'desvio', trecho: JAMMED, n: 300, p: 0.5, justificativa: 'y' })
      expect(sim.active).toBeNull()
      expect(runner.queue.pending()).toHaveLength(1)
      expect(runner.log.entries()[0].texto).toMatch(/desvio parcial está desligado/)
    })

    it('applies greens of 10 to 30 s cards 31 to 60 s and refuses the rest', async () => {
      expect([10, 30, 31, 60, 9, 61].map(decideGreen)).toEqual(['aplicar', 'aplicar', 'aprovar', 'aprovar', 'recusar', 'recusar'])
      const { sim, runner } = setup(scripted([]))
      sim.engine.setAdaptiveSignals(true)
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I11', fase: 'H', verdeS: 25, justificativa: 'fila' })
      // I11's alameda turns green again at 46 s (H 20 + 3, V 20 + 3): that green lasts 25 s
      await runFor(sim, runner, 46_000)
      const i11 = () => sim.engine.getState().lights.find((l) => l.intersectionId === 'I11')!
      expect(i11().h).toBe('verde')
      expect(i11().v).toBe('vermelho')
      expect(i11().remainingS).toBeCloseTo(25, 1)
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I12', fase: 'V', verdeS: 45, justificativa: 'fila longa' })
      expect(runner.queue.pending()).toHaveLength(1)
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I12', fase: 'V', verdeS: 90, justificativa: 'absurdo' })
      expect(runner.queue.pending()).toHaveLength(1)
      expect(runner.log.entries()[0].texto).toMatch(/recusad/)
    })
  })

  describe('approval', () => {
    it('applies on approve logs a rejection and expires after 120 s', async () => {
      const { sim, runner } = setup(scripted([]), 15)
      runner.applyProposal({ tipo: 'desvio', trecho: JAMMED, n: 120, p: 0.4, justificativa: 'acidente' })
      const [a] = runner.queue.pending()
      runner.approve(a.id)
      expect(sim.active).toEqual({ trecho: JAMMED, p: 0.4, mode: 'parcial' })
      expect(runner.queue.get(a.id)!.estado).toBe('aplicada')
      expect(runner.log.entries()[0]).toMatchObject({ origem: 'operador', texto: expect.stringMatching(/aprovad/) })
      runner.approve(a.id) // only once
      expect(runner.log.entries().filter((e) => e.origem === 'operador')).toHaveLength(1)

      runner.applyProposal({ tipo: 'desvio', trecho: 'I22>I23', n: 90, p: 0.45, justificativa: 'x' })
      const [b] = runner.queue.pending()
      runner.reject(b.id)
      expect(sim.active).toEqual({ trecho: JAMMED, p: 0.4, mode: 'parcial' })
      expect(runner.queue.get(b.id)!.estado).toBe('rejeitada')
      expect(runner.log.entries()[0]).toMatchObject({ origem: 'operador', texto: expect.stringMatching(/rejeitad/) })

      runner.applyProposal({ tipo: 'desvio', trecho: 'I33>I34', n: 90, p: 0.5, justificativa: 'y' })
      const [c] = runner.queue.pending()
      await runFor(sim, runner, 119_900)
      expect(runner.queue.get(c.id)!.estado).toBe('aguardando')
      await runFor(sim, runner, 100)
      expect(runner.queue.get(c.id)!.estado).toBe('expirada')
      runner.approve(c.id) // too late
      expect(sim.active?.trecho).not.toBe('I33>I34')

      // a green card approved while signal control is off is not applied, and says so
      runner.applyProposal({ tipo: 'semaforo', intersecao: 'I11', fase: 'H', verdeS: 45, justificativa: 'fila' })
      const [g] = runner.queue.pending()
      runner.approve(g.id)
      expect(runner.queue.get(g.id)!.estado).toBe('nao-aplicada')
      expect(runner.log.entries()[0].texto).toMatch(/aprovado, mas não aplicado/)
      // a diversion card approved after "Desvio parcial" was turned off is not applied either
      runner.applyProposal({ tipo: 'desvio', trecho: 'I42>I43', n: 90, p: 0.6, justificativa: 'z' })
      const [d] = runner.queue.pending()
      sim.setDiversionEnabled(false)
      runner.approve(d.id)
      expect(runner.queue.get(d.id)!.estado).toBe('nao-aplicada')
      expect(sim.active).toBeNull()
    })
  })

  describe('fallback', () => {
    it('runs the rules without the LLM on 503 502 or timeout and returns to LLM mode', { timeout: 60_000 }, async () => {
      let down = true
      const llm = (async () => {
        if (down) throw new LlmUnavailable('503')
        return { content: [text('ok')], stop_reason: 'end_turn' }
      }) as LlmTurn
      const { sim, runner } = setup(llm, 120)
      await runFor(sim, runner, 30_000)
      expect(runner.mode).toBe('regra')
      expect(runner.log.entries()[0].origem).toBe('regra')
      // an accident in front of U02: the rules divert through the same autonomy policy
      sim.engine.addBlockage(JAMMED, 70)
      await runFor(sim, runner, 200_000)
      const ruleEntries = runner.log.entries().filter((e) => e.origem === 'regra')
      expect(ruleEntries.some((e) => /desvio/i.test(e.texto))).toBe(true)
      const applied = sim.active !== null || runner.queue.all().some((c) => c.acao.tipo === 'desvio')
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
