import { describe, expect, it } from 'vitest'
import { SimulationEngine, STOP_LINE_M, TICK_MS } from './SimulationEngine'
import { lightAt, phaseFor } from './trafficLight'

const FREE_MS = 50 / 3.6

function car(engine: SimulationEngine, id: number) {
  return engine.getState().cars.find((c) => c.id === id)
}

function runFor(engine: SimulationEngine, ms: number, each?: () => void) {
  const end = engine.getState().timeMs + ms
  while (engine.getState().timeMs < end) {
    engine.tick(TICK_MS)
    each?.()
  }
}

/** Smallest gap between consecutive cars on any segment, centre to centre. */
function minGap(engine: SimulationEngine): number {
  const by = new Map<string, number[]>()
  for (const c of engine.getState().cars) by.set(c.path[c.seg], [...(by.get(c.path[c.seg]) ?? []), c.distance])
  let min = Infinity
  for (const xs of by.values()) {
    xs.sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) min = Math.min(min, xs[i] - xs[i - 1])
  }
  return min
}

describe('sim', () => {
  describe('idm', () => {
    it('C41 a queue of 10 stopped cars crosses within 20 s of green', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, cameras: [] })
      const phase = () => phaseFor(lightAt('I12', engine.getState().timeMs), 'H')
      while (phase() !== 'vermelho') engine.tick(TICK_MS)
      const line = engine.segment('I11>I12')!.length - STOP_LINE_M
      // 10 cars standing 7 m apart (5 m car + 2 m gap), the first on the stop line
      const cars = Array.from({ length: 10 }, (_, k) => engine.addCar({ path: ['I11>I12', 'I12>I13'], distance: line - k * 7, velocity: 0 }))
      const crossedAt = new Map<number, number>()
      let green: number | null = null
      let minGap = Infinity
      for (let i = 0; i < 1_200 && crossedAt.size < 10; i++) {
        engine.tick(TICK_MS)
        const now = engine.getState().timeMs
        const p = phase()
        if (green === null && p === 'verde') green = now
        const on = engine.getState().cars.filter((c) => c.path[c.seg] === 'I11>I12').sort((a, b) => a.distance - b.distance)
        for (let k = 1; k < on.length; k++) minGap = Math.min(minGap, on[k].distance - on[k - 1].distance)
        for (const c of cars) {
          const s = engine.getState().cars.find((x) => x.id === c.id)
          if (crossedAt.has(c.id) || !(!s || s.seg > 0 || s.distance > line)) continue
          // nobody crosses on red
          expect(p, `car ${c.id}`).not.toBe('vermelho')
          crossedAt.set(c.id, now)
        }
      }
      expect(green).not.toBeNull()
      expect(crossedAt.size).toBe(10)
      expect(Math.max(...crossedAt.values()) - green!).toBeLessThanOrEqual(20_000)
      // no collision: never closer than 7 m (5 m car + 2 m standstill gap)
      expect(minGap).toBeGreaterThanOrEqual(7 - 1e-9)
    })

    it('accelerates a lone car to 50 km/h within 15 s and never above', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      const around = ['I11>I12', 'I12>I13', 'I13>I14', 'I14>I24', 'I24>I34', 'I34>I44', 'I44>I43', 'I43>I42', 'I42>I41']
      const id = engine.addCar({ path: around, velocity: 0 }).id
      let reachedAt = Infinity
      runFor(engine, 15_000, () => {
        const v = car(engine, id)!.velocity
        expect(v).toBeLessThanOrEqual(FREE_MS + 1e-9)
        if (v * 3.6 >= 49 && reachedAt === Infinity) reachedAt = engine.getState().timeMs
      })
      expect(reachedAt).toBeLessThanOrEqual(15_000)
      // speed only rises on a free road
      const v1 = car(engine, id)!.velocity
      runFor(engine, 5_000)
      expect(car(engine, id)!.velocity).toBeGreaterThanOrEqual(v1)
      expect(car(engine, id)!.velocity).toBeLessThanOrEqual(FREE_MS + 1e-9)

      // a generated car on a clear road enters at 50 km/h and stays there
      const gen = new SimulationEngine({ ratePerMinute: 600, trafficLights: 'always-green' })
      gen.tick(TICK_MS)
      gen.setRate(0)
      const [spawned] = gen.getState().cars
      expect(spawned.velocity).toBeCloseTo(FREE_MS, 9)
      runFor(gen, 30_000, () => {
        const c = gen.getState().cars.find((x) => x.id === spawned.id)
        if (c) expect(c.velocity).toBeCloseTo(FREE_MS, 9)
      })
    })
  })

  describe('SimulationEngine', () => {
    it('keeps at least 7 m between consecutive cars on a segment over 10 minutes at 120 cars per minute', { timeout: 60_000 }, () => {
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      let worst = Infinity
      runFor(engine, 600_000, () => {
        worst = Math.min(worst, minGap(engine))
      })
      expect(worst).toBeGreaterThanOrEqual(7 - 1e-9)
      expect(engine.getState().spawnedTotal).toBe(1200)
    })

    it('never brakes harder than 9 m/s2 over 10 minutes at 120 cars per minute', { timeout: 60_000 }, () => {
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      let prev = new Map<number, number>()
      let worst = 0
      runFor(engine, 600_000, () => {
        const now = new Map<number, number>()
        for (const c of engine.getState().cars) {
          const before = prev.get(c.id)
          if (before !== undefined) worst = Math.max(worst, (before - c.velocity) / (TICK_MS / 1000))
          now.set(c.id, c.velocity)
        }
        prev = now
      })
      expect(worst).toBeLessThanOrEqual(9 + 1e-9) // the emergency cap itself, up to float rounding
    })
  })
})
