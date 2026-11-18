import { classify, STALE_AFTER_MS, type RouteStatus } from '../capacity/CapacityModel'
import type { FusedSegment } from '../fusion/FusionService'

/** Worst first (AC 17). */
export const STATE_ORDER: Record<RouteStatus, number> = { congestionado: 0, carregado: 1, fluindo: 2, 'sem dados': 3 }

export interface RoadRow {
  id: string
  estado: RouteStatus
  velocidade: number | null
}

/** Worst to best state; within a state the lowest speed first ("sem dado" speeds last); then id. */
export function sortRoads<T extends RoadRow>(rows: readonly T[]): T[] {
  const speed = (r: RoadRow) => r.velocidade ?? Infinity
  return [...rows].sort((a, b) => STATE_ORDER[a.estado] - STATE_ORDER[b.estado] || speed(a) - speed(b) || a.id.localeCompare(b.id))
}

/**
 * What the operator sees of a segment's state: the AD-006 rule on the newest fused reading, "sem
 * dados" after 20 s without one - the same rule the capacity model applies, one window earlier.
 */
export function fusedStatus(f: FusedSegment | undefined, nowMs: number): RouteStatus {
  if (!f || f.atualizadoEm === null || nowMs - f.atualizadoEm > STALE_AFTER_MS) return 'sem dados'
  return classify(f.velocidadeMedia)
}
