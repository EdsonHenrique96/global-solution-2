import { describe, expect, it } from 'vitest'
import { advanceCar, positionOnRoute, routeLength } from './car'
import { CarGenerator } from './carGenerator'
import { buildRoadNetwork } from './roadNetwork'
import { SimulationEngine, TICK_MS } from './SimulationEngine'
import type { Route } from './types'

const straight = (id: string): Route => ({
  id,
  points: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
  ],
  intersectionIds: [],
})

describe('sim', () => {
  describe('roadNetwork', () => {
    it('returns identical geometry across two builds', () => {
      const first = buildRoadNetwork()
      const second = buildRoadNetwork()

      expect(second).toEqual(first)
      expect(second).not.toBe(first)
      expect(first.routes.length).toBeGreaterThanOrEqual(2)
      expect(first.routes.length).toBeLessThanOrEqual(3)
      expect(first.intersections).toHaveLength(4)
    })
  })

  describe('carGenerator', () => {
    it('spawns at the configured rate over 60 simulated seconds', () => {
      const routes = buildRoadNetwork().routes
      for (const rate of [30, 120, 7, 1]) {
        const gen = new CarGenerator(rate)
        let spawned = 0
        for (let t = 0; t < 60_000; t += TICK_MS) {
          spawned += gen.tick(TICK_MS, routes).length
        }
        expect(spawned, `${rate} cars/min`).toBe(rate)
      }
    })

    it('assigns routes round-robin across 1 and 3 available routes', () => {
      const one = [straight('only')]
      const genOne = new CarGenerator(600)
      const idsOne: string[] = []
      for (let i = 0; i < 50; i++) idsOne.push(...genOne.tick(TICK_MS, one).map((c) => c.routeId))
      expect(idsOne.length).toBeGreaterThan(0)
      expect(new Set(idsOne)).toEqual(new Set(['only']))

      const three = [straight('a'), straight('b'), straight('c')]
      const genThree = new CarGenerator(600)
      const idsThree: string[] = []
      while (idsThree.length < 9) {
        idsThree.push(...genThree.tick(TICK_MS, three).map((c) => c.routeId))
      }
      expect(idsThree.slice(0, 9)).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c'])
    })

    it('spawns zero cars when configured rate is 0', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      for (let t = 0; t < 60_000; t += TICK_MS) engine.tick(TICK_MS)

      const state = engine.getState()
      expect(state.cars).toHaveLength(0)
      expect(state.spawnedTotal).toBe(0)
      expect(state.network.routes.length).toBeGreaterThanOrEqual(2)
      expect(state.network.intersections).toHaveLength(4)
    })
  })

  describe('car', () => {
    it('advances position along its route at constant speed per tick', () => {
      const route = straight('r')
      const speed = 40 // units per second
      let car = { id: 1, routeId: 'r', distance: 0, speed }
      const positions = [positionOnRoute(route, car.distance)]
      for (let i = 0; i < 30; i++) {
        car = advanceCar(car, TICK_MS)
        positions.push(positionOnRoute(route, car.distance))
        expect(car.distance).toBeCloseTo(speed * (TICK_MS / 1000) * (i + 1), 9)
      }
      // 30 ticks * 4 units = 120: crosses the corner at 100, ends at (100, 20)
      expect(positions[25]).toEqual({ x: 100, y: 0 })
      expect(positions[30].x).toBeCloseTo(100, 9)
      expect(positions[30].y).toBeCloseTo(20, 9)
      // every point lies on the polyline
      for (const p of positions) {
        const onFirst = p.y === 0 && p.x >= 0 && p.x <= 100
        const onSecond = Math.abs(p.x - 100) < 1e-9 && p.y >= 0 && p.y <= 50
        expect(onFirst || onSecond).toBe(true)
      }
    })
  })

  describe('SimulationEngine', () => {
    it('removes a car once it reaches its route\'s destination', () => {
      const engine = new SimulationEngine({ ratePerMinute: 600 })
      engine.tick(TICK_MS) // 600/min -> exactly one car per 100ms tick
      engine.setRate(0)
      const [car] = engine.getState().cars
      expect(car).toBeDefined()

      const route = engine.getState().network.routes.find((r) => r.id === car.routeId)!
      const ticksToArrive = Math.ceil(routeLength(route) / (car.speed * (TICK_MS / 1000)))

      for (let i = 0; i < ticksToArrive - 1; i++) engine.tick(TICK_MS)
      expect(engine.getState().cars.map((c) => c.id)).toContain(car.id)

      engine.tick(TICK_MS)
      expect(engine.getState().cars.map((c) => c.id)).not.toContain(car.id)
      expect(engine.getState().cars).toHaveLength(0)
    })
  })
})
