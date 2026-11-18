/**
 * CO2 per vehicle (esboço, "Modelo de emissão"). Moving: a g/km factor that is high at low speed and
 * lowest near cruise speed; standing: a fixed idle rate. The curve has the shape of COPERT's CO2 x
 * speed curves for a petrol car; the numbers are illustrative and the TCC replaces them with the
 * cited coefficients (plan Assumptions).
 */
export const IDLE_G_PER_S = 0.6
/** Below this speed a car counts as standing. */
export const STANDING_KMH = 5
const MIN_FACTOR_SPEED_KMH = 5

/** g/km at a speed in km/h: 110 + 1397 / v + 0.00204 v^2 (~250 at 10, ~140 at 70, ~151 at 120). */
export function emissionFactor(speedKmh: number): number {
  const v = Math.max(MIN_FACTOR_SPEED_KMH, speedKmh)
  return 110 + 1397 / v + 0.00204 * v * v
}

/** Grams emitted in one step: idle while standing, factor x distance while moving. */
export function stepEmission(distanceM: number, dtS: number): { co2G: number; standing: boolean } {
  const speedKmh = dtS > 0 ? (distanceM / dtS) * 3.6 : 0
  if (speedKmh < STANDING_KMH) return { co2G: IDLE_G_PER_S * dtS, standing: true }
  return { co2G: (emissionFactor(speedKmh) * distanceM) / 1000, standing: false }
}
