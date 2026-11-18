import type { RouteStatus } from '../capacity/CapacityModel'
import type { FusedSegment } from '../fusion/FusionService'
import type { CoverageEntry } from '../sensors/coverage'
import { segmentName } from '../sensors/segments'

export interface TooltipContent {
  nome: string
  estado: string
  contagem: string
  velocidade: string
  densidade: string
  /** The unit that covers it, or "estimado". */
  unidade: string
  confianca: string
  idade: string
  estimado: boolean
  avisos: string[]
}

export const SEM_DADO = 'sem dado'

const fmt = (v: number, digits: number) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const ALERT_NAMES: Record<string, string> = { acidente: 'Acidente' }

/** "U02 (92%)" for the unit with the best camera coverage, or "estimado" when no unit covers it. */
export function coveringUnit(coverage: readonly CoverageEntry[]): string {
  const best = [...coverage].sort((a, b) => b.cobertura - a.cobertura)[0]
  return best ? `${best.sensorId} (${Math.round(best.cobertura * 100)}%)` : 'estimado'
}

/** Everything the operator sees about one segment under the mouse (AC 15). */
export function segmentTooltip(
  segmentId: string,
  coverage: readonly CoverageEntry[],
  fused: FusedSegment | undefined,
  status: RouteStatus,
  nowMs: number,
  /** The segment the diversion is steering drivers away from. */
  jammed: string | null = null,
): TooltipContent {
  const avisos = [...new Set((fused?.alertas ?? []).map((a) => ALERT_NAMES[a.tipo] ?? a.tipo))]
  if (jammed === segmentId) avisos.push('Congestionamento persistente: motoristas com app sendo desviados')
  const estado = status
  return {
    nome: segmentName(segmentId),
    estado: estado === 'sem dados' ? SEM_DADO : estado,
    contagem: fused?.contagem != null ? `${fused.contagem} veíc` : SEM_DADO,
    velocidade: fused?.velocidadeMedia != null ? `${fmt(fused.velocidadeMedia, 1)} km/h` : SEM_DADO,
    densidade: fused?.densidade != null ? `${fmt(fused.densidade, 1)} veíc/km` : SEM_DADO,
    unidade: coveringUnit(coverage),
    confianca: fmt(fused?.confianca ?? 0, 2),
    idade: fused?.atualizadoEm != null ? `${Math.max(0, Math.round((nowMs - fused.atualizadoEm) / 1000))} s` : SEM_DADO,
    estimado: coverage.length === 0 || (fused?.estimado ?? false),
    avisos,
  }
}
