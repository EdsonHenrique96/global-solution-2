import type { Simulation } from '../decision/Simulation'
import { sortRoads } from '../render/roads'
import type { AgentAction } from './ApprovalQueue'

export const TOOL_NAMES = ['estado_rede', 'propor_desvio', 'propor_semaforo', 'registrar_explicacao'] as const
/** How many segments estado_rede shows: the worst ones. */
export const WORST_SEGMENTS = 10

export interface ToolContext {
  sim: Simulation
  /** Runs an action through the autonomy policy; returns what happened. */
  propose: (action: AgentAction) => string
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
  const worst = sortRoads(
    sim.capacity.segments.map((s) => ({ id: s.id, estado: estimates[s.id].estado, velocidade: estimates[s.id].velocidade })),
  ).slice(0, WORST_SEGMENTS)
  return {
    tempoS: sim.engine.getState().timeMs / 1000,
    pioresTrechos: worst.map(({ id }) => {
      const e = estimates[id]
      return {
        trecho: id,
        estado: e.estado,
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

/** Runs one tool call. The size of a diversion always comes from the same sizing the rerouter uses. */
export function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  switch (name) {
    case 'estado_rede':
      return { content: JSON.stringify(networkState(ctx.sim)) }
    case 'propor_desvio': {
      const { trecho, justificativa } = input
      if (typeof trecho !== 'string' || !ctx.sim.capacity.segments.some((s) => s.id === trecho)) {
        return err('trecho inválido: use um id como I12>I13')
      }
      const { n, p, evaluations } = ctx.sim.sizing(trecho)
      const resultado = ctx.propose({ tipo: 'desvio', trecho, n, p, justificativa: String(justificativa ?? '') })
      return { content: JSON.stringify({ n, p, candidatos: evaluations.length, resultado }) }
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
