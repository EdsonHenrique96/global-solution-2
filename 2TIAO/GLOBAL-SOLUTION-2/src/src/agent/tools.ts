import { diversionSize } from '../decision/DiversionController'
import type { Simulation } from '../decision/Simulation'
import type { AgentAction } from './ApprovalQueue'

export const TOOL_NAMES = ['estado_rede', 'propor_desvio', 'propor_semaforo', 'registrar_explicacao'] as const
const ROUTES = ['central', 'norte', 'sul']
const INTERSECTIONS = ['I1', 'I2', 'I3', 'I4']

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

const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)

/** What the agent sees: aggregated state only, never individual cars. */
export function networkState(sim: Simulation): Record<string, unknown> {
  const routes = sim.capacity.routes()
  const demand = sim.demand()
  const fused = sim.capacity.fusion.state()
  const { samples: _samples, ...metricas } = sim.metrics.snapshot()
  void _samples
  return {
    tempoS: sim.engine.getState().timeMs / 1000,
    rotas: Object.fromEntries(
      Object.entries(routes).map(([id, r]) => [
        id,
        { estado: r.estado, velocidadeKmh: round(r.velocidade), fluxoVeicH: round(r.fluxo), capacidadeVeicH: round(r.capacidade), folgaVeicH: round(r.folga), demandaVeicH: round(demand[id]) },
      ]),
    ),
    alertas: Object.entries(fused)
      .filter(([, f]) => f.alertas.length > 0)
      .map(([trecho, f]) => ({ trecho, quantidade: f.alertas.length, tipos: [...new Set(f.alertas.map((a) => a.tipo))] })),
    filas: Object.fromEntries(INTERSECTIONS.map((i) => [i, sim.engine.queueAt(i)])),
    desvio: sim.engine.getState().diversion,
    metricas,
  }
}

const err = (content: string): ToolResult => ({ content, is_error: true })

/** Runs one tool call. The numbers of a diversion always come from diversionSize. */
export function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  switch (name) {
    case 'estado_rede':
      return { content: JSON.stringify(networkState(ctx.sim)) }
    case 'propor_desvio': {
      const { de, para, justificativa } = input
      if (typeof de !== 'string' || typeof para !== 'string' || !ROUTES.includes(de) || !ROUTES.includes(para) || de === para) {
        return err('rotas inválidas: use central, norte ou sul, diferentes')
      }
      const routes = ctx.sim.capacity.routes()
      const { n, p } = diversionSize(ctx.sim.demand()[de] ?? 0, routes[de].fluxo, routes[para].folga ?? 0)
      const resultado = ctx.propose({ tipo: 'desvio', de, para, n, p, justificativa: String(justificativa ?? '') })
      return { content: JSON.stringify({ n, p, resultado }) }
    }
    case 'propor_semaforo': {
      const { intersecao, verde_s, justificativa } = input
      if (typeof intersecao !== 'string' || !INTERSECTIONS.includes(intersecao) || typeof verde_s !== 'number' || !Number.isFinite(verde_s)) {
        return err('semáforo inválido: intersecao I1 a I4 e verde_s em segundos')
      }
      const resultado = ctx.propose({ tipo: 'semaforo', intersecao, verdeS: Math.round(verde_s), justificativa: String(justificativa ?? '') })
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
