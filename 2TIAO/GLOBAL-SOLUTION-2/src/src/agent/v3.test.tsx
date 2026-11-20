import { AppPanel } from '../render/AppPanel'
import { CONFIGURED_CAPACITY_VEH_H as cap } from '../capacity/CapacityModel'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
  return { sim, agent, transport, call, propose, explain }
}

describe('V3', () => {
  it('audita a decisão explícita de manter a rota em uma chamada ao modelo', async () => {
    const why = 'A simulação mantém o trecho abaixo do limite com 0% de desvio.'
    const model = vi.fn<LlmTurn>(async messages => {
      expect(messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'simular_desvio'))).toBe(true)
      return { stop_reason:'tool_use', content:[{type:'tool_use', id:'why', name:'registrar_explicacao', input:{texto:why,decisao:'manter_rota'}}] }
    })
    const {agent, sim} = setup(0, model)
    agent.onEvent(event)
    await agent.idle()
    expect(model).toHaveBeenCalledTimes(1)
    expect(agent.audit.list()).toHaveLength(1)
    expect(agent.audit.list()[0]).toMatchObject({origem:'agente', decisao:'sem desvio', evento:event, justificativa:why, numeros:{ganhoCo2Kg:0}})
    expect(sim.active).toBeNull()
  })
  it('não registra sem desvio para um comentário genérico ou texto final', async () => {
    const generic = 'O congestionamento exige nova avaliação.'
    const cases: LlmTurn[] = [
      async () => ({ stop_reason:'tool_use', content:[{type:'tool_use', id:'nota', name:'registrar_explicacao', input:{texto:generic}}] }),
      async () => ({ stop_reason:'end_turn', content:[{type:'text', text:'ok'}] }),
    ]
    for (const model of cases) {
      const {agent} = setup(0.2, model)
      agent.onEvent(event)
      await agent.idle()
      expect(agent.audit.list()).toEqual([])
    }
  })
  it('C1 Eventos estruturados de dois trechos abrem dois turnos; o mesmo trecho aguarda 120 s', async () => {
    const seen: unknown[] = []
    const {agent,sim} = setup(0.3, async m => {seen.push(JSON.parse(String(m[0].content))); return {content:[{type:'text',text:'ok'}],stop_reason:'end_turn'}})
    const off = agent.connect()

    agent.onEvent(event)
    sim.engine.tick(30000)
    agent.onEvent({...event,ts:30000})
    agent.onEvent({...event,trecho:'I22>I23',ts:30000})
    expect(seen).toEqual([event,{...event,trecho:'I22>I23',ts:30000}])
    sim.engine.tick(90000)
    agent.onEvent({...event,ts:120000})
    expect(seen).toHaveLength(3)
    await agent.idle()
    const live = new Simulation({ transport:new FakeTransport(true), prever:async () => ({modelo:'teste',previsoes:{[id]:{v15:4,f15:100,v30:3,f30:110}}}) })
    const received: unknown[] = []
    const observer = new AgentRunner({sim:live,llm:async ([m])=>{
      received.push(JSON.parse(String(m.content))); return { content:[{type:'text',text:'avaliado'}],stop_reason:'end_turn' }
    }})
    observer.connect()
    for (let t=60000;t<=600000;t+=60000) live.history.record(t,{[id]:{fluxo:300,capacidade:600,velocidade:15,densidade:30}},{avgSpeed:15,travelMin:1})
    live.engine.tick(600000)
    live.forecast!.tick(600000)
    await Promise.resolve(); await observer.idle()
    expect(received).toContainEqual(expect.objectContaining({tipo:'previsao', trecho:id, ts:600000,dados:expect.objectContaining({f15:100})}))
    off()
  })
  it('C2 consultar_trecho traz medidas e estimado e rejeita trecho desconhecido', () => {
    const {call} = setup()
    expect(JSON.parse(call('consultar_trecho').content)).toEqual({trecho:id, nome:expect.any(String), velocidadeKmh:12, densidadeVeicKm:40, fluxoVeicMin:8, capacidadeVeicMin:expect.closeTo(cap/60,2), ocupacaoPct:Math.round(48000/cap), nivel:'critico', estimado:false})
    expect(JSON.parse(call('consultar_trecho',{trecho:'I11>I12'}).content).estimado).toBe(true)
    expect(JSON.parse(call('consultar_trecho',{trecho:'x'}).content)).toEqual({erro:'trecho_desconhecido'})
  })
  it('C3 prever_trecho retorna previsão e indisponibilidade', () => {
    const {sim,call} = setup()
    expect(JSON.parse(call('prever_trecho').content)).toMatchObject({v15:10,f15:15,v30:8,f30:18,ocupacao15Pct:Math.round(900000/cap)/10,ocupacao30Pct:Math.round(1080000/cap)/10})
    sim.forecast!.status = 'indisponivel'
    expect(JSON.parse(call('prever_trecho').content)).toEqual({trecho:id,indisponivel:true})
  })
  it('C4 simular_desvio retorna as sete frações ou cálculo pendente', () => {
    const {sim,call} = setup()
    expect(JSON.parse(call('simular_desvio').content).fracoes.map((r:{fracao:number})=>r.fracao)).toEqual(FRACOES)
    expect(JSON.parse(call('simular_desvio').content)).toMatchObject({escolhida:0.3,fracoes:sim.fractionsFor(id)!.fracoes})
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
    const figures = screen.getByText(/ganho de CO₂/)
    for (const label of [`Ocupação atual ${entry.numeros!.ocupacaoAtualPct}%`, `prevista ${entry.numeros!.ocupacaoPrevistaPct!.toLocaleString('pt-BR')}%`, 'alternativa 50%', 'ganho de tempo 3 s', 'ganho de CO₂ 0,3 kg']) expect(figures).toHaveTextContent(label)
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
    const {call,explain} = setup(0.4)
    const proof = JSON.parse(call('simular_desvio').content)
    const input = {trecho:id,fracao:proof.escolhida,numeros:proof.numeros,justificativa:'fila'}
    expect(JSON.parse(call('propor_desvio',{...input,fracao:0.2}).content).erro).toBe('simulacao_divergente')
    expect(JSON.parse(call('propor_desvio',input).content)).toEqual({resultado:'aguardando',cardId:1})
    for (const input of [{trecho:'x'}, {trecho:id,fracao:-1}, {trecho:id,fracao:1.1}]) {
      const rejected = call('propor_desvio',input)
      expect(rejected.is_error).toBe(true)
      expect(JSON.parse(rejected.content).erro).toBe(input.trecho === 'x' ? 'trecho_desconhecido' : 'fracao_invalida')
      expect(explain).toHaveBeenCalled()
      explain.mockClear()
    }
  })
  it('C9 A aprovação aplica e registra a decisão', () => {
    const {agent,sim,propose,transport} = setup(0.4)
    for (let t=100;t<10000;t+=100) sim.tick()
    deliverMetrics(transport,id,9900,{k:60,v:3,ocupacao:8})
    sim.engine.addCar({ path:['I11>I12',id,'I13>I14'],distance:0,velocity:0,app:'waze' })
    propose()
    render(<><AgentPanel mode="llm" log={[]} cards={agent.queue.pending()} onApprove={i=>agent.approve(i)} onReject={i=>agent.reject(i)}/><AppPanel transport={transport} diversion={sim.diversion}/></>)
    expect(screen.getByText(/ganho de CO₂/)).toHaveTextContent('ganho de tempo 4 s')
    fireEvent.click(screen.getByRole('button',{name:'Aprovar'})); act(()=>sim.tick())
    expect(screen.getByTestId('apps-enviadas-waze')).toHaveTextContent('1')
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
    const blocked = setup()
    const readings = blocked.sim.readings()
    vi.spyOn(blocked.sim, 'readings').mockReturnValue({...readings,[id]:{...readings[id],exibido:'verificacao'}})
    blocked.agent.onEvent({...event,tipo:'previsao'}); await blocked.agent.idle()
    expect(blocked.sim.active).toBeNull()
    expect(blocked.agent.audit.list()[0]).toMatchObject({decisao:'recusada',justificativa:expect.stringContaining('confirmação')})
    expect(agent.audit.list()[0]).toMatchObject({origem:'regra',justificativa:expect.stringMatching(/ocupação prevista .*fração 30%.*ganho estimado 3 s/)})
  })
  it('C13 Auditoria retém evento e decisão para cada proposta', async () => {
    const {agent} = setup(0)
    agent.onEvent(event); await agent.idle()
    const [entry] = agent.audit.list()
    expect(Object.keys(entry).sort()).toEqual(['id','ts','evento','origem','acao','numeros','justificativa','decisao','decididoEm','resultado'].sort())
    expect(entry).toMatchObject({id:1,ts:0,origem:'regra',decididoEm:0,acao:{tipo:'desvio',trecho:id,p:0},numeros:{ganhoTempoS:0,ganhoCo2Kg:0,ocupacaoAtualPct:expect.any(Number),ocupacaoPrevistaPct:expect.any(Number),ocupacaoAlternativaPct:50}})
    expect(agent.audit.list()[0]).toMatchObject({evento:event,decisao:'sem desvio',justificativa:expect.stringMatching(/sem desvio já atende/),resultado:null})
  })
  it('C14 Só ações aplicadas têm efeito medido após 600 s', () => {
    const {sim,agent,propose} = setup()
    propose()
    agent.audit.tick(sim,599999); expect(agent.audit.list()[0].resultado).toBeNull()
    agent.audit.tick(sim,600000); expect(agent.audit.list()[0].resultado).toMatchObject({medidoEm:600000,ocupacaoTrechoPct:expect.any(Number)})
    const delayed = setup(0.4)
    delayed.sim.engine.tick(100)
    delayed.sim.engine.addCar({path:['I11>I12',id,'I13>I14'],velocity:0,app:'waze'})
    deliverMetrics(delayed.transport,id,100,{k:60,v:3,ocupacao:8})
    delayed.propose()
    delayed.sim.engine.tick(89900); delayed.agent.approve(1)
    delayed.agent.audit.tick(delayed.sim,600000)
    expect(delayed.agent.audit.list()[0].resultado).toBeNull()
    const action = delayed.agent.audit.list()[0].acao
    if(action.tipo !== 'desvio') throw Error('Ação incorreta')
    const [alt] = action.evidencia!.alternativas
    expect(alt).toBeTruthy()
    deliverMetrics(delayed.transport,id,90000,{k:50,v:3,fluxoVeicMin:4})
    deliverMetrics(delayed.transport,alt,90000,{k:40,v:20,fluxoVeicMin:8})
    vi.spyOn(delayed.sim.engine,'travelStats').mockReturnValue({...delayed.sim.engine.travelStats(),lastMinuteAvgS:34})
    delayed.agent.audit.tick(delayed.sim,690000)
    expect(delayed.agent.audit.list()[0].resultado).toEqual({medidoEm:690000,ocupacaoTrechoPct:Math.round(24000/cap),ocupacaoAlternativaPct:Math.round(48000/cap),tempoMedioS:34})
    const refused = setup(0.4)
    refused.propose(); refused.agent.reject(1); refused.agent.audit.tick(refused.sim,600000)
    expect(refused.agent.audit.list()[0].resultado).toBeNull()
  })
  it('C15 Relatórios lista decisões e baixa auditoria-agente.json', async () => {
    const {agent,propose} = setup()
    const view = render(<AuditReport entries={[]} />)
    expect(screen.getByText('Nenhuma proposta do agente ainda')).toBeVisible()
    propose()
    agent.applyProposal({tipo:'semaforo',intersecao:'I11',fase:'V',verdeS:45,justificativa:'fila transversal'})
    view.rerender(<AuditReport entries={agent.audit.list()} />)
    expect(screen.getByText(/I12>I13 · automatica/)).toBeVisible()
    const clicked = vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this: HTMLAnchorElement) { expect(this.download).toBe('auditoria-agente.json') })
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('fila transversal')
    let exported!: Blob
    vi.stubGlobal('URL',class extends URL { static createObjectURL(blob:Blob) {exported=blob;return 'blob:teste'} static revokeObjectURL() {} })
    fireEvent.click(screen.getByRole('button',{name:'Baixar auditoria'}))
    expect(JSON.parse(await exported.text())).toEqual(agent.audit.list())
    expect(clicked).toHaveBeenCalledOnce(); clicked.mockRestore(); vi.unstubAllGlobals()
  })
  it('C16 UC01 com semente 1001 e 15 carros/min registra a decisão, inclusive se zero', async () => {
    const sim = new Simulation({transport:new FakeTransport(true),engine:new SimulationEngine({ratePerMinute:15,seed:1001}),agentControl:true, prever:async () => ({modelo:'teste',previsoes:{[id]:{v15:12,f15:7,v30:10,f30:8}}})})
    sim.start()
    const agent = new AgentRunner({sim,llm:down})
    for(let t=0;t<600000;t+=100) sim.tick()
    await Promise.resolve()
    sim.reportAccident(id,70,300000)
    sim.tick(); agent.tick(); await agent.idle()
    expect(agent.audit.list()).toContainEqual(expect.objectContaining({evento:expect.objectContaining({trecho:id}),origem:'regra',numeros:{ocupacaoAtualPct:expect.any(Number),ocupacaoPrevistaPct:expect.any(Number),ocupacaoAlternativaPct:expect.any(Number),ganhoTempoS:expect.any(Number),ganhoCo2Kg:expect.any(Number)}}))
  },60000)
})
