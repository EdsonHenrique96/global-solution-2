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
    it('stops a car at the stop line 12 m before a red light until green', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(engine, 23_000) // I1 turns red at 23 s, green again at 43 s
      expect(light(engine, 'I1').phase).toBe('vermelho')

      const id = engine.addCar('central', 180).id
      runUntil(engine, 30_000)
      expect(car(engine, id)!.distance).toBeCloseTo(I1_STOP_LINE, 6)
      expect(car(engine, id)!.velocity).toBe(0)

      runUntil(engine, 42_900)
      expect(car(engine, id)!.distance).toBeCloseTo(I1_STOP_LINE, 6)
      expect(car(engine, id)!.velocity).toBe(0)

      runUntil(engine, 43_000)
      expect(light(engine, 'I1').phase).toBe('verde')
      engine.tick(TICK_MS)
      expect(car(engine, id)!.distance).toBeGreaterThan(I1_STOP_LINE)
      expect(car(engine, id)!.velocity).toBeCloseTo(FREE_MS, 6)
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

    it('queues cars 8 m apart behind a stopped car on the same route', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(engine, 23_000)
      const ids = [engine.addCar('central', 150).id, engine.addCar('central', 120).id, engine.addCar('central', 90).id]
      // a car on another route is not part of this queue
      const other = engine.addCar('norte', 100).id
      runUntil(engine, 40_000)

      const positions = ids.map((id) => car(engine, id)!.distance)
      expect(positions[0]).toBeCloseTo(I1_STOP_LINE, 6)
      expect(positions[1]).toBeCloseTo(I1_STOP_LINE - 8, 6)
      expect(positions[2]).toBeCloseTo(I1_STOP_LINE - 16, 6)
      for (const id of ids) expect(car(engine, id)!.velocity).toBe(0)
      expect(car(engine, other)).toBeDefined()
      expect(car(engine, other)!.distance).toBeGreaterThan(I1_STOP_LINE)
    })

    it('releases the queue at 50 km/h on green leader first', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runUntil(engine, 23_000)
      const ids = [engine.addCar('central', 150).id, engine.addCar('central', 120).id, engine.addCar('central', 90).id]
      runUntil(engine, 43_000)
      expect(light(engine, 'I1').phase).toBe('verde')

      const started: number[] = []
      for (let tick = 0; tick < 50; tick++) {
        engine.tick(TICK_MS)
        ids.forEach((id, i) => {
          if (started[i] === undefined && car(engine, id)!.velocity > 0) started[i] = tick
        })
      }
      expect(started[0]).toBe(0)
      expect(started[1]).toBeGreaterThan(started[0])
      expect(started[2]).toBeGreaterThan(started[1])
      for (const id of ids) expect(car(engine, id)!.velocity).toBeCloseTo(FREE_MS, 6)
      // order kept, never closer than 8 m
      const [d0, d1, d2] = ids.map((id) => car(engine, id)!.distance)
      expect(d0 - d1).toBeGreaterThanOrEqual(8 - 1e-9)
      expect(d1 - d2).toBeGreaterThanOrEqual(8 - 1e-9)
    })
  })
})
