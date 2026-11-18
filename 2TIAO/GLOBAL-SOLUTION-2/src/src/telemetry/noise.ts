/** Multiplies `value` by (1 + u), u uniform in [-pct/100, +pct/100]. */
export function applyNoise(value: number, pct: number, rng: () => number): number {
  if (pct === 0) return value
  const u = (rng() * 2 - 1) * (pct / 100)
  return value * (1 + u)
}
