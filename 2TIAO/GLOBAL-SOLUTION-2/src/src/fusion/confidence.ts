/** A segment's metrics are fresh for one recomputation (10 s); after that they age. */
export const FRESH_MS = 10_000
/** Confidence falls linearly from FRESH_MS to FRESH_MS + DECAY_MS, down to the floor. */
export const DECAY_MS = 120_000
export const CONFIDENCE_FLOOR = 0.2

/** Confidence of a reading `ageMs` old: unchanged while fresh, then linear down to the floor. */
export function agedConfidence(base: number, ageMs: number): number {
  if (ageMs <= FRESH_MS) return base
  return Math.max(CONFIDENCE_FLOOR, base * (1 - (ageMs - FRESH_MS) / DECAY_MS))
}
