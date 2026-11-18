/** Coverage at or above this gives full confidence. */
export const FULL_COVERAGE = 0.8
/** A reading is fresh for one sensor window; after that it ages. */
export const FRESH_MS = 10_000
/** Confidence falls linearly from FRESH_MS to FRESH_MS + DECAY_MS, down to the floor. */
export const DECAY_MS = 120_000
export const CONFIDENCE_FLOOR = 0.2

/** 1.0 at coverage >= 0.8, proportional below it. */
export function baseConfidence(cobertura: number): number {
  return cobertura >= FULL_COVERAGE ? 1 : Math.max(0, cobertura / FULL_COVERAGE)
}

/** Confidence of a reading `ageMs` old: unchanged while fresh, then linear down to the floor. */
export function agedConfidence(base: number, ageMs: number): number {
  if (ageMs <= FRESH_MS) return base
  return Math.max(CONFIDENCE_FLOOR, base * (1 - (ageMs - FRESH_MS) / DECAY_MS))
}
