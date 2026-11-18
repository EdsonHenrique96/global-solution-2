import type { FusedSegment } from '../fusion/FusionService'
import type { CoverageEntry } from '../sensors/coverage'
import { segmentName } from '../sensors/segments'

export interface TooltipContent {
  nome: string
  sensores: string
  fontes: string
  confianca: string
  idade: string
  estimado: boolean
  alertas: number
  demanda: string
}

const fmt = (v: number, digits: number) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** What the operator sees about one segment: who measures it, how much to trust it, how old it is. */
export function segmentTooltip(
  segmentId: string,
  coverage: readonly CoverageEntry[],
  fused: FusedSegment | undefined,
  nowMs: number,
): TooltipContent {
  const sensores = coverage.length
    ? [...coverage]
        .sort((a, b) => b.cobertura - a.cobertura)
        .map((e) => `${e.sensorId} ${Math.round(e.cobertura * 100)}%`)
        .join(', ')
    : 'nenhuma'
  return {
    nome: segmentName(segmentId),
    sensores,
    fontes: fused && fused.fontes.length ? fused.fontes.join(', ') : 'nenhuma',
    confianca: fmt(fused?.confianca ?? 0, 2),
    idade: fused?.atualizadoEm != null ? `${Math.max(0, Math.round((nowMs - fused.atualizadoEm) / 1000))} s` : 'sem dado',
    estimado: fused?.estimado ?? false,
    alertas: fused?.alertas.length ?? 0,
    demanda: fused?.demandaOD != null ? `${Math.round(fused.demandaOD)} veíc/h` : '—',
  }
}
