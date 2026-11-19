/** A segment's level: what the map paints and what the diversion reacts to (AD-082). */
export type Nivel = 'livre' | 'moderado' | 'intenso' | 'critico' | 'aprendendo' | 'sem dado'

/** What a classifier sees of a segment with fresh data. */
export interface ClassifierInput {
  /** Measured flow, veh/h; null without an estimate. */
  fluxo: number | null
  /** Learned capacity, veh/h; null while learning. */
  capacidade: number | null
  /** Pair speed, km/h; null without a pair. */
  velocidade: number | null
  /** veh/km; null without metrics. */
  densidade: number | null
}

/**
 * The one state rule (AD-082). V1 runs the AD-047 rule with AD-080; V2 plugs the K-means (AD-074)
 * in through this same interface. "sem dado" (stale data) is decided before any classifier runs.
 */
export interface SegmentClassifier {
  readonly nome: string
  classify(input: ClassifierInput): Exclude<Nivel, 'sem dado'>
}

/** Below this pair speed a segment is critical, whatever its flow (AD-080). */
export const CRITICAL_SPEED_KMH = 15

/** pct = round(fluxo ÷ capacidade × 100) -> level; below 15 km/h the segment is critical (AD-047, AD-080). */
export function nivelOf(pct: number, velocidade: number | null): Exclude<Nivel, 'aprendendo' | 'sem dado'> {
  if (velocidade !== null && velocidade < CRITICAL_SPEED_KMH) return 'critico'
  if (pct >= 90) return 'critico'
  if (pct >= 75) return 'intenso'
  if (pct >= 50) return 'moderado'
  return 'livre'
}

/** AD-047 with AD-080: flow over learned capacity, and critical below 15 km/h even while learning. */
export const ruleClassifier: SegmentClassifier = {
  nome: 'regra AD-047 com AD-080',
  classify({ fluxo, capacidade, velocidade }) {
    if (capacidade === null || capacidade <= 0 || fluxo === null) {
      // a stopped queue is critical even before its capacity is known
      return velocidade !== null && velocidade < CRITICAL_SPEED_KMH ? 'critico' : 'aprendendo'
    }
    return nivelOf(Math.round((fluxo / capacidade) * 100), velocidade)
  },
}
