import { describe, expect, it } from 'vitest'
import { SimulationEngine, TICK_MS } from './SimulationEngine'

const FREE_KMH = 50
const FREE_MS = FREE_KMH / 3.6
// Central route: origin (60,300) -> I1 (300,300) -> I2 (700,300) -> destination (940,300).
// I1 sits 240 m along it; its stop line is 12 m before: 228 m.
const I1_STOP_LINE = 228

function runUntil(engine: SimulationEngine, timeMs: number) {
  while (engine.getState().timeMs < timeMs) engine.tick(TICK_MS)
}

function light(engine: SimulationEngine, id: string) {
  return engine.getState().lights.find((l) => l.intersectionId === id)!
}

function car(engine: SimulationEngine, id: number) {
  return engine.getState().cars.find((c) => c.id === id)
}

describe('sim', () => {
  describe('trafficLight', () => {
    it('cycles green 20s yellow 3s red 20s with per-intersection offsets', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      // [time s, intersection, phase, remaining s]
      const table: [number, string, string, number][] = [
        [0, 'I1', 'verde', 20],
        [0, 'I2', 'verde', 10],
        [0, 'I3', 'verde', 15],
        [0, 'I4', 'verde', 5],
        [12, 'I2', 'amarelo', 1],
        [12, 'I4', 'vermelho', 16],
        [21, 'I1', 'amarelo', 2],
        [23, 'I1', 'vermelho', 20],
        [42, 'I1', 'vermelho', 1],
        [43, 'I1', 'verde', 20],
        [43, 'I3', 'verde', 15],
        [86, 'I1', 'verde', 20],
      ]
      for (const [t, id, phase, remaining] of table) {
        runUntil(engine, t * 1000)
        const l = light(engine, id)
        expect(l.phase, `${id} at ${t}s`).toBe(phase)
        expect(l.remainingS, `${id} at ${t}s`).toBeCloseTo(remaining, 6)
      }
    })
  })

  describe('SimulationEngine', () => {
    it('stops a car at most 2 m before the line of a red light and never past it until green', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(engine, 23_000) // I1 turns red at 23 s, green again at 43 s
      expect(light(engine, 'I1').phase).toBe('vermelho')

      // 48 m before the line at 50 km/h: needs ~2 m/s², well under 4.5 m/s²
      const id = engine.addCar('central', 180).id
      while (engine.getState().timeMs < 43_000) {
        engine.tick(TICK_MS)
        expect(car(engine, id)!.distance).toBeLessThanOrEqual(I1_STOP_LINE + 1e-9)
      }
      expect(car(engine, id)!.distance).toBeGreaterThanOrEqual(I1_STOP_LINE - 2)
      expect(car(engine, id)!.velocity).toBeLessThan(0.01)

      expect(light(engine, 'I1').phase).toBe('verde')
      runUntil(engine, 48_000)
      expect(car(engine, id)!.distance).toBeGreaterThan(I1_STOP_LINE)
      expect(car(engine, id)!.velocity).toBeGreaterThan(0)
    })

    it('lets a car past the stop line or on yellow go through', () => {
      // Past the line when it turns red: at 22.9 s (yellow) the car is at 235 m, past 228.
      const past = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(past, 22_900)
      const a = past.addCar('central', 235).id
      runUntil(past, 25_000)
      expect(light(past, 'I1').phase).toBe('vermelho')
      expect(car(past, a)!.distance).toBeGreaterThan(260)
      expect(car(past, a)!.velocity).toBeCloseTo(FREE_MS, 6)

      // Yellow (20 s - 23 s) stops nobody: a car crossing the line during yellow keeps going.
      const yellow = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(yellow, 20_000)
      expect(light(yellow, 'I1').phase).toBe('amarelo')
      const b = yellow.addCar('central', 210).id
      runUntil(yellow, 22_000)
      expect(car(yellow, b)!.distance).toBeGreaterThan(I1_STOP_LINE + 5)
      expect(car(yellow, b)!.velocity).toBeCloseTo(FREE_MS, 6)
    })

    it('queues cars 7 to 10 m apart behind a stopped car', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(engine, 23_000)
      const ids = [engine.addCar('central', 180).id, engine.addCar('central', 150).id, engine.addCar('central', 125).id]
      runUntil(engine, 40_000)

      const positions = ids.map((id) => car(engine, id)!.distance)
      expect(positions[0]).toBeLessThanOrEqual(I1_STOP_LINE + 1e-9)
      expect(positions[0]).toBeGreaterThanOrEqual(I1_STOP_LINE - 2)
      for (const gap of [positions[0] - positions[1], positions[1] - positions[2]]) {
        expect(gap).toBeGreaterThanOrEqual(7)
        expect(gap).toBeLessThanOrEqual(10)
      }
      for (const id of ids) expect(car(engine, id)!.velocity).toBeLessThan(0.01)
    })

    it('releases the queue leader first with everyone above 30 km/h within 25 s', () => {
      // north queue at I3 (red 18 s - 38 s); no other light after it, so the road ahead is clear
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(engine, 18_000)
      expect(light(engine, 'I3').phase).toBe('vermelho')
      const ids = [470, 440, 415].map((d) => engine.addCar('norte', d).id)
      runUntil(engine, 38_000)
      expect(light(engine, 'I3').phase).toBe('verde')

      const started: number[] = []
      const reached: number[] = []
      for (let tick = 0; tick < 250; tick++) {
        engine.tick(TICK_MS)
        ids.forEach((id, i) => {
          const c = car(engine, id)
          if (!c) return
          if (started[i] === undefined && c.velocity > 0.01) started[i] = tick
          if (reached[i] === undefined && c.velocity * 3.6 > 30) reached[i] = tick
        })
        const [d0, d1, d2] = ids.map((id) => car(engine, id)?.distance ?? Infinity)
        if (Number.isFinite(d1)) expect(d0).toBeGreaterThan(d1)
        if (Number.isFinite(d2)) expect(d1).toBeGreaterThan(d2)
      }
      expect(started[0]).toBeLessThan(started[1])
      expect(started[1]).toBeLessThan(started[2])
      for (let i = 0; i < 3; i++) expect(reached[i], `car ${i}`).toBeLessThanOrEqual(250)
    })
  })
})
