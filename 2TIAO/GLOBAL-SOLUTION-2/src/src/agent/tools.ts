import { evidence, forecastFor, type Evidence } from './ProposalAudit'
import { segmentName } from '../sensors/segments'
import type { Simulation } from '../decision/Simulation'
import { compareSaturation } from '../render/levels'
import type { AgentAction } from './ApprovalQueue'

export const TOOL_NAMES = ['estado_rede', 'consultar_trecho', 'prever_trecho', 'simular_desvio', 'propor_desvio', 'propor_semaforo', 'registrar_explicacao'] as const
/** How many segments estado_rede shows: the worst ones. */
export const WORST_SEGMENTS = 10

export interface ToolContext {
  sim: Simulation
  simulations?: Map<string, { p: number; proof: Evidence }>
  /** Runs an action through the autonomy policy; returns what happened. */
  propose: (action: AgentAction) => string
  refuse?: (trecho: string, p: number, reason: string) => void
  explain: (texto: string) => void
}

export interface ToolResult {
  content: string
  is_error?: boolean
}

const round = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10)

/** What the agent sees: aggregated state only, never individual cars. */
export function networkState(sim: Simulation): Record<string, unknown> {
  const estimates = sim.capacity.snapshot()
  const fused = sim.capacity.fusion.state()
  const { samples: _samples, ...metricas } = sim.metrics.snapshot()
  void _samples
  const apps = sim.fleet.snapshot()
  const levels = sim.readings()
  // the most saturated first, by the same level the map and the diversion use (AD-082)
  const ranked = Object.values(levels).map((r) => ({ ...r, nivel: r.exibido === 'verificacao' ? 'critico' as const : r.exibido }))
  const worst = ranked.sort(compareSaturation).slice(0, WORST_SEGMENTS)
  return {
    tempoS: sim.engine.getState().timeMs / 1000,
    pioresTrechos: worst.map(({ id }) => {
      const e = estimates[id]
      return {
        trecho: id,
        nivel: levels[id].exibido,
        velocidadeKmh: round(e.velocidade),
        densidadeVeicKm: round(e.densidade),
        fluxoVeicH: round(e.fluxo),
        capacidadeVeicH: round(e.capacidade),
        folgaVeicH: round(e.folga),
        demandaVeicH: round(fused[id]?.demandaOD),
        estimado: fused[id]?.fontes.length === 0,
      }
    }),
    alertas: Object.entries(fused)
      .filter(([, f]) => f.alertas.length > 0)
      .map(([trecho, f]) => ({ trecho, quantidade: f.alertas.length, tipos: [...new Set(f.alertas.map((a) => a.tipo))] })),
    filas: Object.fromEntries(sim.engine.getState().network.intersections.map((i) => [i.id, { H: sim.engine.queueAt(i.id, 'H'), V: sim.engine.queueAt(i.id, 'V') }])),
    motoristasComApp: { total: apps.total, porApp: apps.porApp },
    desvio: sim.active,
    metricas,
  }
}

const err = (content: string): ToolResult => ({ content, is_error: true })

/**
 * Runs one tool call. The size of a diversion always comes from the same sizing the rerouter uses:
 * the smallest effective fraction simulated ahead (RF18), returned with its table (door 6) so the
 * agent can justify the proposal with numbers.
 */
export function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  switch (name) {
    case 'consultar_trecho':
    case 'prever_trecho':
    case 'simular_desvio': {
      const id = input.trecho
      if (typeof id !== 'string' || !ctx.sim.engine.segment(id)) return err(JSON.stringify({ erro: 'trecho_desconhecido' }))
      if (name === 'prever_trecho') return { content: JSON.stringify(forecastFor(ctx.sim, id)) }
      if (name === 'simular_desvio') {
        const sizing = ctx.sim.sizing(id)
        if (!sizing) return { content: JSON.stringify({ calculando: true }) }
        const proof = evidence(ctx.sim, id, sizing)
        ctx.simulations?.set(id, { p: sizing.p, proof })
        return { content: JSON.stringify({ ...sizing.simulacao, numeros: proof.numeros }) }
      }
      const r = ctx.sim.readings()[id]
      return { content: JSON.stringify({ trecho: id, nome: segmentName(id), velocidadeKmh: r.velocidade,
        fluxoVeicMin: r.fluxo === null ? null : r.fluxo / 60, densidadeVeicKm: r.densidade, ocupacaoPct: r.pct,
        capacidadeVeicMin: r.capacidade === null ? null : r.capacidade / 60, nivel: r.exibido,
        estimado: !ctx.sim.capacity.fusion.state()[id]?.fontes.length }) }
    }
    case 'estado_rede':
      return { content: JSON.stringify(networkState(ctx.sim)) }
    case 'propor_desvio': {
      const { trecho, justificativa } = input
      if (typeof trecho !== 'string' || !ctx.sim.capacity.segments.some((s) => s.id === trecho)) {
        ctx.refuse?.(String(trecho ?? ''), 0, 'Trecho desconhecido')
        ctx.explain('Desvio recusado: trecho desconhecido.')
        return err(JSON.stringify({ erro: 'trecho_desconhecido', mensagem: 'trecho inválido: use um id como I12>I13' }))
      }
      if (input.fracao !== undefined && (typeof input.fracao !== 'number' || !Number.isFinite(input.fracao) || input.fracao < 0 || input.fracao > 1)) {
        ctx.refuse?.(trecho, Number(input.fracao), 'Fração inválida')
        ctx.explain('Desvio recusado: fração fora de [0, 1].')
        return err(JSON.stringify({ erro: 'fracao_invalida' }))
      }
      if (ctx.sim.readings()[trecho].exibido === 'verificacao') {
        const reason = 'Possível incidente aguarda confirmação.'
        ctx.explain(reason)
        ctx.refuse?.(trecho, 0, reason)
        return err(reason)
      }
      const sizing = ctx.sim.sizing(trecho)
      if (!sizing) {
        ctx.explain(`Desvio de ${trecho} ainda não recomendado: frações em cálculo; reavaliar na próxima janela.`)
        return { content: JSON.stringify({ calculando: true, mensagem: 'frações em cálculo; consulte de novo na próxima janela' }) }
      }
      // The tool result the model just read is the evidence for this proposal. Live readings
      // can advance while the provider answers. The selected fraction must still be valid.
      const quoted = ctx.simulations?.get(trecho)
      const proof = quoted?.p === sizing.p ? quoted.proof : evidence(ctx.sim, trecho, sizing)
      if (input.fracao !== undefined) {
        const numbers = input.numeros as Record<string, unknown> | undefined
        if (input.fracao !== sizing.p || !numbers || Object.entries(proof.numeros).some(([k,v]) => numbers[k] !== v)) {
          const reason = 'A proposta diverge do cálculo. Reavalie a fração e os indicadores retornados.'
          ctx.simulations?.set(trecho, { p: sizing.p, proof })
          ctx.refuse?.(trecho, input.fracao as number, reason)
          ctx.explain(reason)
          return err(JSON.stringify({ erro: 'simulacao_divergente', mensagem: reason, trecho, fracao: sizing.p, numeros: proof.numeros }))
        }
      }
      let why = String(justificativa ?? '')
      if (sizing.p === 0) {
        const baseline = sizing.simulacao.fracoes.find((f) => f.fracao === 0)
        why = `Sem desvio de ${trecho}: ${sizing.simulacao.eficaz ? 'o cenário sem desvio já atende aos limites da simulação' : 'nenhuma fração simulada alivia o trecho sem saturar as alternativas'}. Ocupação máxima sem desvio: ${baseline?.ocupacaoMaxTrecho ?? '—'}%; candidatos com app: ${sizing.evaluations.length}.`
        ctx.explain(why)
      }
      const { n, p, evaluations, simulacao } = sizing
      const resultado = ctx.propose({ tipo: 'desvio', trecho, n, p, evidencia: proof, justificativa: why })
      if (input.fracao !== undefined) {
        const card = /card (\d+)/.exec(resultado)
        const decision = card ? { resultado: 'aguardando', cardId: Number(card[1]) }
          : { resultado: resultado.startsWith('aplicado') ? 'aplicada' : p === 0 ? 'sem desvio' : 'recusada' }
        return { content: JSON.stringify(decision) }
      }
      return { content: JSON.stringify({ n, p, candidatos: evaluations.length, simulacao, resultado }) }
    }
    case 'propor_semaforo': {
      const { intersecao, fase, verde_s, justificativa } = input
      const ids = ctx.sim.engine.getState().network.intersections.map((i) => i.id)
      if (
        typeof intersecao !== 'string' ||
        !ids.includes(intersecao) ||
        (fase !== 'H' && fase !== 'V') ||
        typeof verde_s !== 'number' ||
        !Number.isFinite(verde_s)
      ) {
        return err('semáforo inválido: intersecao I11 a I44, fase H ou V e verde_s em segundos')
      }
      const resultado = ctx.propose({ tipo: 'semaforo', intersecao, fase, verdeS: Math.round(verde_s), justificativa: String(justificativa ?? '') })
      return { content: JSON.stringify({ resultado }) }
    }
    case 'registrar_explicacao': {
      if (typeof input.texto !== 'string' || !input.texto.trim()) return err('texto vazio')
      ctx.explain(input.texto.trim())
      return { content: 'registrado' }
    }
    default:
      return err(`ferramenta desconhecida: ${name}`)
  }
}
