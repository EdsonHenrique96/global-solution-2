import { describe, expect, it } from 'vitest'
import { adaptiveGreenS } from './trafficLight'
import { SimulationEngine, TICK_MS } from './SimulationEngine'

const FREE_MS = 50 / 3.6

function runFor(engine: SimulationEngine, ms: number, each?: () => void) {
  const end = engine.getState().timeMs + ms
  while (engine.getState().timeMs < end) {
    engine.tick(TICK_MS)
    each?.()
  }
}
const car = (e: SimulationEngine, id: number) => e.getState().cars.find((c) => c.id === id)

describe('sim', () => {
  describe('blockage', () => {
    it('cars stop at least 7 m behind a blockage and cars past it keep going', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      engine.addBlockage('central', 400)
      const behind = engine.addCar('central', 300).id
      const past = engine.addCar('central', 420).id
      runFor(engine, 30_000, () => {
        const b = car(engine, behind)!
        expect(b.distance).toBeLessThanOrEqual(400 - 7 + 1e-9)
      })
      expect(car(engine, behind)!.velocity).toBeLessThan(0.01)
      expect(car(engine, behind)!.distance).toBeGreaterThan(400 - 12)
      // the car past the blockage drove on at full speed (30 s at 50 km/h ~ 417 m)
      expect(car(engine, past)!.distance).toBeGreaterThan(420 + 400)
      expect(car(engine, past)!.velocity).toBeCloseTo(FREE_MS, 6)
      // a blockage on central does not stop the north route
      const n = engine.addCar('norte', 300).id
      runFor(engine, 3_000)
      expect(car(engine, n)!.velocity).toBeCloseTo(FREE_MS, 6)
    })

    it('expires after 120 simulated seconds and traffic resumes', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      const block = engine.addBlockage('central', 400)
      expect(block.endsAtMs).toBe(120_000)
      const id = engine.addCar('central', 300).id
      runFor(engine, 119_900)
      expect(engine.getState().blockages).toHaveLength(1)
      expect(car(engine, id)!.velocity).toBeLessThan(0.01)
      runFor(engine, 100)
      expect(engine.getState().blockages).toHaveLength(0)
      runFor(engine, 10_000)
      expect(car(engine, id)!.distance).toBeGreaterThan(420)

      // removed by hand before it expires
      const other = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      const b2 = other.addBlockage('sul', 500)
      other.removeBlockage(b2.id)
      expect(other.getState().blockages).toHaveLength(0)
    })
  })

  describe('diversion', () => {
    it('sends exactly a fraction p of the cars bound for A to B and leaves cars on the road alone', () => {
      // 300 cars/min round-robin: 100 bound for central per minute
      const engine = new SimulationEngine({ ratePerMinute: 300, trafficLights: 'always-green' })
      const onRoad = engine.addCar('central', 200).id
      const finalRoute = new Map<number, string>()
      engine.onArrival((a) => finalRoute.set(a.carId, a.routeId))
      engine.setDiversion({ from: 'central', to: 'norte', fraction: 0.4 })
      runFor(engine, 60_000)
      engine.setRate(0)
      runFor(engine, 120_000) // let everybody in
      const s = engine.getState()
      expect(s.spawnedTotal).toBe(300)
      expect(s.divertedTotal).toBe(40)
      expect(s.routeTotals).toEqual({ central: 60, norte: 140, sul: 100 })
      // the car already on central stayed on central
      expect(finalRoute.get(onRoad)).toBe('central')

      // without a diversion nothing changes route
      const plain = new SimulationEngine({ ratePerMinute: 300, trafficLights: 'always-green' })
      runFor(plain, 60_000)
      plain.setRate(0)
      runFor(plain, 120_000)
      expect(plain.getState().divertedTotal).toBe(0)
      expect(plain.getState().routeTotals).toEqual({ central: 100, norte: 100, sul: 100 })
    })
  })

  describe('adaptiveSignals', () => {
    it('sets each green from its queue against the average clamped to 15 to 30 s', () => {
      expect(adaptiveGreenS(10, 4)).toBe(30)
      expect(adaptiveGreenS(2, 4)).toBe(16)
      expect(adaptiveGreenS(0, 6)).toBe(15)
      expect(adaptiveGreenS(5, 5)).toBe(20)

      // in the engine: a queue of 6 at I1 (others empty, average 1.5) -> 20 + 2 * 4.5 = 29 s green
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      engine.setAdaptiveSignals(true)
      runFor(engine, 23_000) // I1 red from 23 s to 43 s
      // far enough from the line to stop (the dilemma zone would let a car at 8 m go through)
      for (const d of [200, 185, 170, 155, 140, 125]) engine.addCar('central', d)
      runFor(engine, 20_000)
      const i1 = () => engine.getState().lights.find((l) => l.intersectionId === 'I1')!
      expect(i1().phase).toBe('verde')
      expect(i1().remainingS).toBeCloseTo(29, 1)
      // yellow 3 s then red 20 s after the green
      runFor(engine, 29_000)
      expect(i1().phase).toBe('amarelo')
      expect(i1().remainingS).toBeCloseTo(3, 1)
      runFor(engine, 3_000)
      expect(i1().phase).toBe('vermelho')
      expect(i1().remainingS).toBeCloseTo(20, 1)
    })

    it('measures the queue as cars under 5 km/h in the 150 m before the stop line', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runFor(engine, 23_000) // I1 red; stop line at 228 m on central
      engine.addCar('central', 228, 0) // at the line, stopped
      engine.addCar('central', 100, 0) // stopped but 128 m before the line: counts (within 150 m)
      engine.addCar('central', 70, 0) // stopped 158 m before: does not count
      engine.addCar('central', 150, 5) // 5 m/s = 18 km/h: moving, does not count
      engine.addCar('central', 240, 0) // past the line: does not count
      expect(engine.queueAt('I1')).toBe(2)
    })
  })

  describe('metrics', () => {
    it('averages travel time from generation to arrival over the last minute and since start', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      const arrivals: { travelS: number; at: number }[] = []
      engine.onArrival((a) => arrivals.push({ travelS: a.travelS, at: a.atMs }))
      engine.addCar('central', 0) // born now (0 s); 880 m at 50 km/h -> 63.36 s
      runFor(engine, 70_000)
      expect(arrivals).toHaveLength(1)
      expect(arrivals[0].travelS).toBeCloseTo(880 / FREE_MS, 0)
      const stats = engine.travelStats()
      expect(stats.allAvgS).toBeCloseTo(arrivals[0].travelS, 6)
      expect(stats.lastMinuteAvgS).toBeCloseTo(arrivals[0].travelS, 6)
      runFor(engine, 60_000) // the arrival leaves the last-minute window
      expect(engine.travelStats().lastMinuteAvgS).toBeNull()
      expect(engine.travelStats().allAvgS).toBeCloseTo(arrivals[0].travelS, 6)

      // waiting at the origin counts as travel time: generated cars include the wait
      const busy = new SimulationEngine({ ratePerMinute: 600, trafficLights: 'always-green' })
      runFor(busy, 10_000)
      busy.setRate(0)
      runFor(busy, 200_000)
      const s = busy.travelStats()
      expect(s.allAvgS!).toBeGreaterThan(880 / FREE_MS)
    })

    it('counts the total queue as slow cars on the road plus cars waiting at the origin', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      engine.addCar('central', 300, 0)
      engine.addCar('norte', 300, 1) // 3.6 km/h: slow
      engine.addCar('sul', 300) // 50 km/h: not in the queue
      expect(engine.queueTotal()).toBe(2)
      const jam = new SimulationEngine({ ratePerMinute: 6000, trafficLights: 'always-green' })
      runFor(jam, 1_000)
      const s = jam.getState()
      expect(s.waitingAtOrigin).toBeGreaterThan(0)
      const slow = s.cars.filter((c) => c.velocity < 5 / 3.6).length
      expect(jam.queueTotal()).toBe(slow + s.waitingAtOrigin)
    })
  })
})
