import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Simulation } from '../decision/Simulation'
import { FRACOES } from '../decision/simulateDiversion'
import { SimulationEngine } from '../sim/SimulationEngine'
import { FakeTransport, deliverMetrics } from '../telemetry/testing'
import { AgentPanel } from '../render/AgentPanel'
import { AuditReport } from '../render/AuditReport'
import { AgentRunner } from './AgentRunner'
import { executeTool } from './tools'
import { LlmUnavailable, type LlmTurn } from './llm'
import type { AgentAction } from './ApprovalQueue'

const id = 'I12>I13'
const event = { tipo: 'congestionamento' as const, trecho:id, ts:0, dados:{ nivel:'critico' } }
const down: LlmTurn = async () => { throw new LlmUnavailable('503') }
function setup(p = 0.3, llm = down) {
  const transport = new FakeTransport(true)
  const sim = new Simulation({ transport, agentControl:true, engine:new SimulationEngine({ratePerMinute:0, cameras:[]}),
    prever:async () => ({ modelo:'teste', previsoes:{} }),
    simulateDiversion: (_sim, trecho) => ({ trecho, horizonteMin:10, escolhida:p, eficaz:true, fracoes:FRACOES.map(fracao => ({
      fracao, ocupacaoMaxTrecho:95 - fracao * 20, ocupacaoMaxAlternativa:50, tempoMedioS:100 - fracao * 10, co2Kg:10 - fracao,
    })) }) })
  sim.start()
  deliverMetrics(transport, id, 0, {k:40, v:12, ocupacao:5})
  sim.forecast!.previsoes[id] = {v15:10,f15:15,v30:8,f30:18}
  const agent = new AgentRunner({sim,llm})
  const explain = vi.fn()
  const call = (name: string, input: Record<string, unknown> = {trecho:id}) => executeTool(name,input,{sim,propose:(a: AgentAction)=>agent.applyProposal(a),explain})
  const propose = () => call('propor_desvio',{trecho:id, justificativa:'fila no trecho'})
  return { sim, agent, call, propose, explain }
}

describe('V3', () => {
  it('C1 Eventos estruturados de dois trechos abrem dois turnos; o mesmo trecho aguarda 120 s', async () => {
    const seen: unknown[] = []
    const {agent,sim} = setup(0.3, async m => {seen.push(JSON.parse(String(m[0].content))); return {content:[{type:'text',text:'ok'}],stop_reason:'end_turn'}})
    const off = agent.connect()
    sim.forecast!.tick(600000)
    agent.onEvent(event)
    sim.engine.tick(30000)
    agent.onEvent({...event,ts:30000})
    agent.onEvent({...event,trecho:'I22>I23',ts:30000})
    expect(seen).toEqual([event,{...event,trecho:'I22>I23',ts:30000}])
    sim.engine.tick(90000)
    agent.onEvent({...event,ts:120000})
    expect(seen).toHaveLength(3)
    await agent.idle()
    off()
  })
  it('C2 consultar_trecho traz medidas e estimado e rejeita trecho desconhecido', () => {
    const {call} = setup()
    expect(JSON.parse(call('consultar_trecho').content)).toMatchObject({trecho:id, velocidadeKmh:12, densidadeVeicKm:40})
    expect(JSON.parse(call('consultar_trecho',{trecho:'I11>I12'}).content).estimado).toBe(true)
    expect(JSON.parse(call('consultar_trecho',{trecho:'x'}).content)).toEqual({erro:'trecho_desconhecido'})
  })
  it('C3 prever_trecho retorna previsão e indisponibilidade', () => {
    const {sim,call} = setup()
    expect(JSON.parse(call('prever_trecho').content)).toMatchObject({v15:10,f15:15,v30:8,f30:18,ocupacao15Pct:expect.any(Number)})
    sim.forecast!.status = 'indisponivel'
    expect(JSON.parse(call('prever_trecho').content)).toEqual({trecho:id,indisponivel:true})
  })
  it('C4 simular_desvio retorna as sete frações ou cálculo pendente', () => {
    const {sim,call} = setup()
    expect(JSON.parse(call('simular_desvio').content).fracoes.map((r:{fracao:number})=>r.fracao)).toEqual(FRACOES)
    vi.spyOn(sim,'fractionsFor').mockReturnValue(null)
    expect(JSON.parse(call('simular_desvio').content)).toEqual({calculando:true})
  })
  it('C5 As leituras não expõem placas nem hashes', () => {
    const {call} = setup()
    for (const name of ['consultar_trecho','prever_trecho','simular_desvio','estado_rede']) expect(call(name).content).not.toMatch(/placa|[A-Z]{3}\d[A-Z]\d{2}/i)
  })
  it('C6 A proposta exibe cinco indicadores derivados da simulação', () => {
    const {propose,agent} = setup()
    propose()
    const [entry] = agent.audit.list()
    expect(entry.numeros).toMatchObject({ocupacaoAtualPct:expect.any(Number),ocupacaoPrevistaPct:expect.any(Number),ocupacaoAlternativaPct:50,ganhoTempoS:3,ganhoCo2Kg:expect.closeTo(0.3)})
    render(<AgentPanel automatic={entry.acao} mode="llm" log={[]} cards={[]} onApprove={()=>{}} onReject={()=>{}} />)
    expect(screen.getByText(/Aplicada automaticamente/)).toBeVisible()
    expect(screen.getByText(/ganho de CO₂/)).toHaveTextContent('ganho de tempo 3 s')
  })
  it('C7 0%, 30% e 31% geram sem desvio, automática e aguardando', () => {
    for (const [p,decision] of [[0,'sem desvio'],[0.3,'automatica'],[0.31,'aguardando']] as const) {
      const {agent,sim} = setup()
      agent.applyProposal({tipo:'desvio',trecho:id,p,n:10,justificativa:'teste'})
      expect(agent.audit.list()[0].decisao).toBe(decision)
      expect(sim.active?.p ?? null).toBe(p === 0.3 ? p : null)
    }
  })
  it('C8 Fração inválida e trecho inexistente recusados com log', () => {
    const {call,explain} = setup()
    for (const input of [{trecho:'x'}, {trecho:id,fracao:-1}, {trecho:id,fracao:1.1}]) {
      expect(call('propor_desvio',input).is_error).toBe(true)
      expect(explain).toHaveBeenCalled()
      explain.mockClear()
    }
  })
  it('C9 A aprovação aplica e registra a decisão', () => {
    const {agent,sim,propose} = setup(0.4)
    propose(); agent.approve(1)
    expect(sim.active?.p).toBe(0.4)
    expect(agent.audit.list()[0].decisao).toBe('aprovada')
  })
  it('C10 A rejeição não aplica', () => {
    const {agent,sim,propose} = setup(0.4)
    propose(); agent.reject(1); agent.approve(1)
    expect(sim.active).toBeNull()
    expect(agent.audit.list()[0].decisao).toBe('rejeitada')
  })
  it('C11 Em 120 s o card expira', async () => {
    const {agent,sim,propose} = setup(0.4)
    propose(); sim.engine.tick(120000); agent.tick(); await agent.idle()
    expect(agent.audit.list().find(e=>e.id===1)?.decisao).toBe('expirada')
    expect(sim.active).toBeNull()
  })
  it('C12 Regras explicam ocupação, fração e ganho', async () => {
    const {agent} = setup()
    agent.onEvent(event); await agent.idle()
    expect(agent.audit.list()[0]).toMatchObject({origem:'regra',justificativa:expect.stringMatching(/ocupação prevista .*fração 30%.*ganho estimado 3 s/)})
  })
  it('C13 Auditoria retém evento e decisão para cada proposta', async () => {
    const {agent} = setup(0)
    agent.onEvent(event); await agent.idle()
    expect(agent.audit.list()[0]).toMatchObject({evento:event,decisao:'sem desvio',justificativa:expect.stringMatching(/sem desvio já atende/),resultado:null})
  })
  it('C14 Só ações aplicadas têm efeito medido após 600 s', () => {
    const {sim,agent,propose} = setup()
    propose()
    agent.audit.tick(sim,599999); expect(agent.audit.list()[0].resultado).toBeNull()
    agent.audit.tick(sim,600000); expect(agent.audit.list()[0].resultado).toMatchObject({medidoEm:600000,ocupacaoTrechoPct:expect.any(Number)})
    const refused = setup(0.4)
    refused.propose(); refused.agent.reject(1); refused.agent.audit.tick(refused.sim,600000)
    expect(refused.agent.audit.list()[0].resultado).toBeNull()
  })
  it('C15 Relatórios lista decisões e baixa auditoria-agente.json', () => {
    const {agent,propose} = setup()
    const view = render(<AuditReport entries={[]} />)
    expect(screen.getByText('Nenhuma proposta do agente ainda')).toBeVisible()
    propose()
    view.rerender(<AuditReport entries={agent.audit.list()} />)
    expect(screen.getByText(/I12>I13 · automatica/)).toBeVisible()
    const clicked = vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this: HTMLAnchorElement) { expect(this.download).toBe('auditoria-agente.json') })
    vi.stubGlobal('URL',class extends URL { static createObjectURL() {return 'blob:teste'} static revokeObjectURL() {} })
    fireEvent.click(screen.getByRole('button',{name:'Baixar auditoria'}))
    expect(clicked).toHaveBeenCalledOnce(); clicked.mockRestore(); vi.unstubAllGlobals()
  })
  it('C16 UC01 com semente 1001 e 15 carros/min registra a decisão, inclusive se zero', async () => {
    const sim = new Simulation({transport:new FakeTransport(true),engine:new SimulationEngine({ratePerMinute:15,seed:1001}),agentControl:true})
    sim.start()
    const agent = new AgentRunner({sim,llm:down})
    for(let t=0;t<60000;t+=100) sim.tick()
    sim.reportAccident(id,70,300000)
    sim.tick(); agent.tick(); await agent.idle()
    expect(agent.audit.list()).toContainEqual(expect.objectContaining({evento:expect.objectContaining({trecho:id}),origem:'regra',numeros:expect.objectContaining({ocupacaoAlternativaPct:expect.any(Number),ganhoCo2Kg:expect.any(Number)})}))
  },60000)
})
