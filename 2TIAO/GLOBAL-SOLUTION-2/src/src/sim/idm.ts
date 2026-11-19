/**
 * Intelligent Driver Model (Treiber, Hennecke & Helbing, 2000), urban parameters.
 * Positions are a car's reference point; `gap` is bumper to bumper.
 */
export const IDM = {
  /** Desired speed, m/s (50 km/h). */
  v0: 50 / 3.6,
  /** Time headway, s (1.0: a 10-car queue crosses within 20 s of green, AD-096). */
  T: 1.0,
  /** Maximum acceleration, m/s² (2.5: brisk but realistic start-up, AD-088). */
  a: 2.5,
  /** Comfortable deceleration, m/s². */
  b: 2.0,
  /** Minimum standstill gap, m. */
  s0: 2,
  delta: 4,
  /** Car length, m. */
  length: 5,
} as const

/** Above this deceleration a car facing a fresh red cannot stop and goes through (dilemma zone). */
export const MAX_STOP_DECEL = 4.5
/** Physical limit: no car brakes harder than this (emergency braking). */
export const MAX_DECEL = 9
/** Obstacles farther than this do not affect a car. */
export const LOOKAHEAD_M = 250

/**
 * IDM acceleration. `gap` is the bumper gap to the obstacle ahead (Infinity for a free road),
 * `dv` the approach rate (own speed minus the obstacle's).
 */
export function idmAcceleration(v: number, v0: number, gap: number, dv: number): number {
  const free = 1 - Math.pow(v / v0, IDM.delta)
  if (!Number.isFinite(gap)) return IDM.a * free
  const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)))
  const s = Math.max(gap, 0.01)
  return IDM.a * (free - (sStar / s) ** 2)
}

/**
 * Ballistic step over `dt` seconds: speed never negative, never above v0, and the car never
 * advances more than `maxAdvance` metres (the room before its obstacle).
 */
export function step(
  x: number,
  v: number,
  acc: number,
  v0: number,
  dt: number,
  maxAdvance: number,
): { x: number; v: number } {
  let vNext = Math.min(v0, Math.max(0, v + acc * dt))
  let advance: number
  if (v + acc * dt < 0) {
    // stops within the step
    advance = acc < 0 ? (v * v) / (-2 * acc) : 0
    vNext = 0
  } else {
    advance = ((v + vNext) / 2) * dt
  }
  const room = Math.max(0, maxAdvance)
  if (advance > room) {
    advance = room
    vNext = Math.min(vNext, room / dt)
  }
  return { x: x + Math.max(0, advance), v: vNext }
}

/**
 * Constant deceleration that lets a car `mine` metres from a junction arrive there the IDM
 * following distance (length + s0 + T v) behind a car `theirs` metres from it going at `vTheirs`.
 * 0 when no braking is needed.
 */
export function yieldDeceleration(v: number, mine: number, theirs: number, vTheirs: number): number {
  if (v <= 0) return 0
  // the spacing IDM wants behind them at their speed: length + s0 + T v
  const spacing = IDM.length + IDM.s0 + IDM.T * vTheirs
  const budget = mine - spacing // how far I may travel before they reach the junction
  if (budget <= 0) return MAX_DECEL
  // a car (nearly) standing before the junction never gets there: stop within the budget
  const t = vTheirs > 0.1 ? theirs / vTheirs : Infinity
  if (Number.isFinite(t) && v * t <= budget) return 0
  // stopping inside the window: v^2 / 2b <= budget; otherwise v t - b t^2 / 2 = budget
  const stopping = (v * v) / (2 * budget)
  return !Number.isFinite(t) || v / stopping <= t ? stopping : (2 * (v * t - budget)) / (t * t)
}
