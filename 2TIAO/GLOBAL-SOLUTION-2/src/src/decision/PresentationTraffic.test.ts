import type { AgentEvent } from '../agent/ProposalAudit'
import { describe, expect, it } from 'vitest'
import { AgentRunner } from '../agent/AgentRunner'
import { LlmUnavailable } from '../agent/llm'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'
import { PresentationTraffic } from './PresentationTraffic'
import { Simulation } from './Simulation'

describe('apresentação', () => {
  it('gera um desvio positivo e uma decisão de verde nos primeiros 40 segundos', {timeout: 60_000}, async () => {
    const sim = new Simulation({engine:new SimulationEngine({seed:42}), transport:new FakeTransport(true), agentControl:true})
    sim.start()
    const demo = new PresentationTraffic()
    const agent = new AgentRunner({sim,llm:async () => { throw new LlmUnavailable('sem provedor') }})
    expect(demo.tick(sim)).toBeNull()
    demo.start(sim)
    const events: AgentEvent[] = []
    for (let t = 0; t < 40_000; t += TICK_MS) {
      sim.tick()
      const event = demo.tick(sim)
      if (event) {
        events.push(event)
        agent.onEvent(event)
      }
      agent.tick(demo.active)
      if (event || (t + TICK_MS) % 10000 === 0) await agent.idle()
    }
    expect(events.map(e => [e.ts,e.tipo])).toEqual([[10000,'congestionamento'],[40000,'fila']])
    const first = agent.audit.list().find(e => e.evento === events[0])
    expect(first?.acao.tipo).toBe('desvio')
    if (first?.acao.tipo !== 'desvio') throw Error('Sem proposta de desvio')
    expect(first.acao.p).toBeGreaterThan(0)
    expect(first.acao.p).toBeLessThan(1)
    expect(sim.notifiedTotal).toBeGreaterThan(0)
    const light = agent.audit.list().find(e => e.evento === events[1])
    expect(light).toMatchObject({decisao:'automatica',acao:{tipo:'semaforo',intersecao:'I22',fase:'H'}})
    expect(events[1].dados.H).toBeGreaterThan(Number(events[1].dados.V))
    const manual = sim.engine.addBlockage('I44>I43',70)
    demo.stop(sim)
    expect(sim.engine.getState().adaptiveSignals).toBe(false)
    expect(sim.engine.getState().blockages.map(b => b.id)).toEqual([manual.id])
    sim.engine.tick(30_000)
    expect(demo.tick(sim)).toBeNull()
  })
})
