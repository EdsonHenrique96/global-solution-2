/** A seeded random source that can be copied mid-sequence: the copy draws what the original would. */
export type Rng = (() => number) & { clone(): Rng }

/** Small seeded PRNG (mulberry32): same seed, same sequence. Returns values in [0, 1). */
export function mulberry32(seed: number): Rng {
  return fromState(seed >>> 0)
}

function fromState(state: number): Rng {
  let a = state
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }) as Rng
  next.clone = () => fromState(a)
  return next
}

/** A copy of a random source when it can be copied; otherwise the same one. */
export const cloneRng = (rng: () => number): (() => number) => ('clone' in rng && typeof rng.clone === 'function' ? (rng as Rng).clone() : rng)
