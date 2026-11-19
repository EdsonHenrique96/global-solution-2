/** A seeded random source that can be copied mid-sequence: the copy draws what the original would. */
export type Rng = (() => number) & { clone(): Rng; state(): number }

/** Small seeded PRNG (mulberry32): same seed, same sequence. Returns values in [0, 1). */
export function mulberry32(seed: number): Rng {
  return rngFromState(seed >>> 0)
}

/** The source that continues from `state` (what `rng.state()` returned): it can cross a worker boundary. */
export function rngFromState(state: number): Rng {
  let a = state
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }) as Rng
  next.clone = () => rngFromState(a)
  next.state = () => a
  return next
}

const isRng = (rng: () => number): rng is Rng => 'state' in rng && typeof rng.state === 'function'

/** A copy of a random source when it can be copied; otherwise the same one. */
export const cloneRng = (rng: () => number): (() => number) => (isRng(rng) ? rng.clone() : rng)

/** A random source's state, or null for one that has none (Math.random). */
export const rngState = (rng: () => number): number | null => (isRng(rng) ? rng.state() : null)
