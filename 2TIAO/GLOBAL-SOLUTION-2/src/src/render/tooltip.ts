import type { Nivel } from '../capacity/SegmentClassifier'
import type { FusedSegment } from '../fusion/FusionService'
import { segmentName } from '../sensors/segments'
import { NIVEIS } from './levels'

export interface TooltipContent {
  nome: string
  estado: string
  contagem: string
  velocidade: string
  densidade: string
  /** The segment's camera pair, or "estimado". */
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

/** "C02E · C02S" for a segment with a camera pair, or "estimado" without one. */
export function pairLabel(pair: readonly [string, string] | null): string {
  return pair ? pair.join(' · ') : 'estimado'
}

/** Everything the operator sees about one segment under the mouse (AC 15). */
export function segmentTooltip(
  segmentId: string,
  pair: readonly [string, string] | null,
  fused: FusedSegment | undefined,
  /** The segment's level (AD-082), the same the map paints. */
  nivel: Nivel,
  nowMs: number,
  /** The segment the diversion is steering drivers away from. */
  jammed: string | null = null,
): TooltipContent {
  const avisos = [...new Set((fused?.alertas ?? []).map((a) => ALERT_NAMES[a.tipo] ?? a.tipo))]
  if (jammed === segmentId) avisos.push('Congestionamento persistente: motoristas com app sendo desviados')
  return {
    nome: segmentName(segmentId),
    estado: NIVEIS[nivel].label,
    contagem: fused?.contagem != null ? `${fused.contagem} veíc` : SEM_DADO,
    velocidade:
      fused?.velocidadeMedia != null
        ? `${fmt(fused.velocidadeMedia, 1)} km/h${fused.velocidadeUltimoParEm != null ? ` · último par há ${Math.max(0, Math.round((nowMs - fused.velocidadeUltimoParEm) / 1000))} s` : ''}`
        : SEM_DADO,
    densidade: fused?.densidade != null ? `${fmt(fused.densidade, 1)} veíc/km` : SEM_DADO,
    unidade: pairLabel(pair),
    confianca: fmt(fused?.confianca ?? 0, 2),
    idade: fused?.atualizadoEm != null ? `${Math.max(0, Math.round((nowMs - fused.atualizadoEm) / 1000))} s` : SEM_DADO,
    estimado: pair === null || (fused?.estimado ?? false),
    avisos,
  }
}
