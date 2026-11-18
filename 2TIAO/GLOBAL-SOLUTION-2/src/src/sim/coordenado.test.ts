import { describe, expect, it } from 'vitest'
import { CYCLE_MS, LIGHT_OFFSETS_S, SignalController } from './trafficLight'

const IDS = ['I1', 'I2', 'I3', 'I4'] as const
const STEP = 100

/** Steps the controller and records when each light's green starts. */
function drive(c: SignalController, fromMs: number, toMs: number, queueOf: (id: string, t: number) => number) {
  const starts: Record<string, number[]> = { I1: [], I2: [], I3: [], I4: [] }
  let prev = Object.fromEntries(c.lights(fromMs).map((l) => [l.intersectionId, l.phase]))
  for (let t = fromMs + STEP; t <= toMs; t += STEP) {
    c.advance(t, (id) => queueOf(id, t))
    for (const l of c.lights(t)) {
      if (l.phase === 'verde' && prev[l.intersectionId] !== 'verde') starts[l.intersectionId].push(t)
      prev[l.intersectionId] = l.phase
    }
  }
  return starts
}

const phaseOf = (c: SignalController, id: string, t: number) => c.lights(t).find((l) => l.intersectionId === id)!

describe('sim', () => {
  describe('coordinated', () => {
    it('starts every adaptive green on its fixed-cycle boundary', () => {
      const c = new SignalController(IDS)
      c.setAdaptive(true, 0)
      // queues that change every few seconds, different per light: greens of every length 15-30 s
      const queueOf = (id: string, t: number) => (Math.floor(t / 7_000) * (IDS.indexOf(id as (typeof IDS)[number]) + 3)) % 11
      const starts = drive(c, 0, 10 * CYCLE_MS + 5_000, queueOf)
      for (const id of IDS) {
        expect(starts[id].length).toBeGreaterThanOrEqual(10)
        for (const t of starts[id]) expect((t + LIGHT_OFFSETS_S[id] * 1000) % CYCLE_MS).toBe(0)
      }

      // a light with no queue while the others have 6: green 15 s, then yellow 3 s, then red 25 s
      const short = new SignalController(IDS)
      short.setAdaptive(true, 0)
      drive(short, 0, 43_000, (id) => (id === 'I1' ? 0 : 6))
      expect(phaseOf(short, 'I1', 43_000)).toMatchObject({ phase: 'verde', remainingS: 15 })
      drive(short, 43_000, 58_000, (id) => (id === 'I1' ? 0 : 6))
      expect(phaseOf(short, 'I1', 58_000)).toMatchObject({ phase: 'amarelo', remainingS: 3 })
      drive(short, 58_000, 61_000, (id) => (id === 'I1' ? 0 : 6))
      expect(phaseOf(short, 'I1', 61_000)).toMatchObject({ phase: 'vermelho', remainingS: 25 })
    })

    it('stretches a long approved green to the next aligned start with at least 10 s of red', () => {
      const c = new SignalController(IDS)
      c.setAdaptive(true, 0)
      drive(c, 0, 30_000, () => 0)
      expect(c.setNextGreen('I1', 45)).toBe(true)
      drive(c, 30_000, 43_000, () => 0)
      expect(phaseOf(c, 'I1', 43_000)).toMatchObject({ phase: 'verde', remainingS: 45 })
      drive(c, 43_000, 88_000, () => 0)
      expect(phaseOf(c, 'I1', 88_000)).toMatchObject({ phase: 'amarelo', remainingS: 3 })
      drive(c, 88_000, 91_000, () => 0)
      // 91 + 10 = 101 s; the next start aligned to 43 s is 129 s
      expect(phaseOf(c, 'I1', 91_000)).toMatchObject({ phase: 'vermelho', remainingS: 38 })
      // the cycles after it stay aligned
      const starts = drive(c, 91_000, 91_000 + 5 * CYCLE_MS, () => 0)
      expect(starts.I1.slice(0, 3)).toEqual([129_000, 172_000, 215_000])
      for (const id of IDS) for (const t of starts[id]) expect((t + LIGHT_OFFSETS_S[id] * 1000) % CYCLE_MS).toBe(0)
    })
  })
})
