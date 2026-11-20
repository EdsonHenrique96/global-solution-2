import type { Simulation, Sizing } from '../decision/Simulation'
import { forecastOccupancy } from '../forecast/ForecastClient'
import type { AgentAction } from './ApprovalQueue'
export interface AgentEvent {
  tipo: 'previsao' | 'congestionamento' | 'janela' | 'alerta'
  trecho: string | null
  ts: number
  dados: Record<string, unknown>
}
export function forecastFor(sim: Simulation, trecho: string) {
  const f = sim.forecast
  const p = f?.previsoes[trecho]
  if (!p || f?.status === 'indisponivel') return { trecho, indisponivel: true } as const
  const cap = sim.capacity.snapshot()[trecho]?.capacidade
  return { trecho, ...p, ocupacao15Pct: forecastOccupancy(p.f15, cap), ocupacao30Pct: forecastOccupancy(p.f30, cap) }
}
export function evidence(sim: Simulation, trecho: string, sizing: Sizing) {
  const rows = sizing.simulacao.fracoes
  const baseline = rows.find(r => r.fracao === 0)!
  const chosen = rows.find(r => r.fracao === sizing.p)!
  const forecast = forecastFor(sim, trecho)
  return {
    numeros: {
      ocupacaoAtualPct: sim.readings()[trecho]?.pct ?? null,
      ocupacaoPrevistaPct: forecast.indisponivel ? null : forecast.ocupacao15Pct,
      ocupacaoAlternativaPct: chosen.ocupacaoMaxAlternativa,
      ganhoTempoS: baseline.tempoMedioS === null || chosen.tempoMedioS === null ? null : baseline.tempoMedioS - chosen.tempoMedioS,
      ganhoCo2Kg: baseline.co2Kg - chosen.co2Kg,
    },
    alternativas: [...new Set(sizing.evaluations.filter(e => e.ok).flatMap(e => e.alternative ?? []))].filter(id => id !== trecho),
  }
}
export type Evidence = ReturnType<typeof evidence>
type Decision = 'aguardando' | 'automatica' | 'aprovada' | 'rejeitada' | 'expirada' | 'recusada' | 'sem desvio'
interface Outcome { medidoEm: number; ocupacaoTrechoPct: number | null; ocupacaoAlternativaPct: number | null; tempoMedioS: number | null }
export interface AuditEntry {
  id: number; ts: number; evento: AgentEvent; origem: 'agente' | 'regra'
  acao: AgentAction; numeros: Evidence['numeros'] | null; justificativa: string
  decisao: Decision; decididoEm: number | null; resultado: Outcome | null
}
export class ProposalAudit {
  private entries: AuditEntry[] = []
  private cards = new Map<number, AuditEntry>()
  private measuring = new Set<AuditEntry>()
  list() { return [...this.entries].reverse() }
  add(evento: AgentEvent, origem: AuditEntry['origem'], acao: AgentAction, decisao: Decision, ts: number, cardId?: number) {
    const entry: AuditEntry = { id: this.entries.length + 1, ts, evento, origem, acao, numeros: acao.tipo === 'desvio' ? acao.evidencia?.numeros ?? null : null,
      justificativa: acao.justificativa, decisao, decididoEm: decisao === 'aguardando' ? null : ts, resultado: null }
    this.entries.push(entry)
    if (cardId !== undefined) this.cards.set(cardId, entry)
    if (decisao === 'automatica' && acao.tipo === 'desvio') this.measuring.add(entry)
  }
  settle(cardId: number, decision: Decision, now: number) {
    const entry = this.cards.get(cardId)
    if (!entry) return
    this.cards.delete(cardId)
    entry.decisao = decision
    entry.decididoEm = now
    if (decision === 'aprovada' && entry.acao.tipo === 'desvio') this.measuring.add(entry)
  }
  tick(sim: Simulation, now: number) {
    for (const entry of this.measuring) {
      if (now - entry.decididoEm! < 600000 || entry.acao.tipo !== 'desvio') continue
      const readings = sim.readings()
      const pct = (id: string) => readings[id]?.pct ?? null
      const alternatives = (entry.acao.evidencia?.alternativas ?? []).map(pct).filter(v => v !== null)
      entry.resultado = { medidoEm: now, ocupacaoTrechoPct: pct(entry.acao.trecho),
        ocupacaoAlternativaPct: alternatives.length ? Math.max(...alternatives) : null, tempoMedioS: sim.engine.travelStats().lastMinuteAvgS }
      this.measuring.delete(entry)
    }
  }
}
