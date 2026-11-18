import { describe, expect, it } from 'vitest'
import { routeLength } from './car'
import { buildRoadNetwork } from './roadNetwork'
import { SimulationEngine, TICK_MS } from './SimulationEngine'

const FREE_MS = 50 / 3.6
const SHARED_M = 120 // each route's entrance lane, and the arrival stretch they all share
const lengths = Object.fromEntries(buildRoadNetwork().routes.map((r) => [r.id, routeLength(r)]))

/** Which physical stretch a car is on, and its position along it (from the plan's geometry). */
function stretch(routeId: string, d: number): [string, number] {
  const L = lengths[routeId]
  if (d <= SHARED_M) return [`origem:${routeId}`, d]
  if (d >= L - SHARED_M) return ['chegada', d - (L - SHARED_M)]
  return [routeId, d]
}

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

/** Gaps between consecutive cars on each physical stretch, and whether order is kept per route. */
function minGap(engine: SimulationEngine): number {
  const by = new Map<string, number[]>()
  for (const c of engine.getState().cars) {
    const [s, x] = stretch(c.routeId, c.distance)
    by.set(s, [...(by.get(s) ?? []), x])
  }
  let min = Infinity
  for (const xs of by.values()) {
    xs.sort((a, b) => a - b)
    for (let i = 1; i < xs.length; i++) min = Math.min(min, xs[i] - xs[i - 1])
  }
  return min
}

describe('sim', () => {
  describe('idm', () => {
    it('accelerates a lone car to 50 km/h within 15 s and never above', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      const id = engine.addCar('norte', 150, 0).id
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
    it('keeps at least 7 m between consecutive cars and never reorders over 10 minutes at 120 cars per minute', { timeout: 60_000 }, () => {
      const engine = new SimulationEngine({ ratePerMinute: 120 })
      let worst = Infinity
      runFor(engine, 600_000, () => {
        worst = Math.min(worst, minGap(engine))
        // per route, cars stay in the order they were generated
        const byRoute = new Map<string, { id: number; d: number }[]>()
        for (const c of engine.getState().cars) {
          byRoute.set(c.routeId, [...(byRoute.get(c.routeId) ?? []), { id: c.id, d: c.distance }])
        }
        for (const list of byRoute.values()) {
          list.sort((a, b) => b.d - a.d)
          for (let i = 1; i < list.length; i++) expect(list[i].id).toBeGreaterThan(list[i - 1].id)
        }
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

    it('stops a car that can brake within 2 m before the red line and lets one that cannot go through', () => {
      const STOP = 228
      // 60 m before the line at 50 km/h when I1 turns red (23 s)
      const a = new SimulationEngine({ ratePerMinute: 0 })
      runFor(a, 23_000)
      const far = a.addCar('central', STOP - 60).id
      runFor(a, 19_900, () => expect(car(a, far)!.distance).toBeLessThanOrEqual(STOP + 1e-9))
      expect(car(a, far)!.distance).toBeGreaterThanOrEqual(STOP - 2)
      expect(car(a, far)!.velocity).toBeLessThan(0.01)

      // 10 m before the line at 50 km/h: stopping needs ~9.6 m/s² > 4.5, so it goes through
      const b = new SimulationEngine({ ratePerMinute: 0 })
      runFor(b, 23_000)
      const near = b.addCar('central', STOP - 10).id
      runFor(b, 3_000)
      expect(car(b, near)!.distance).toBeGreaterThan(STOP + 20)
      expect(car(b, near)!.velocity * 3.6).toBeGreaterThan(45)
    })

    it('queues stopped cars 7 to 10 m apart', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runFor(engine, 23_000)
      const ids = [200, 170, 145, 125].map((d) => engine.addCar('central', d).id)
      runFor(engine, 17_000)
      const ds = ids.map((id) => car(engine, id)!.distance)
      for (const id of ids) expect(car(engine, id)!.velocity).toBeLessThan(0.01)
      for (let i = 1; i < ds.length; i++) {
        expect(ds[i - 1] - ds[i]).toBeGreaterThanOrEqual(7)
        expect(ds[i - 1] - ds[i]).toBeLessThanOrEqual(10)
      }
    })

    it('releases the queue leader first and everyone passes 30 km/h within 25 s', () => {
      // north queue at I3 (red 18 s - 38 s); the north route has no light after it
      const engine = new SimulationEngine({ ratePerMinute: 0 })
      runFor(engine, 18_000)
      const ids = [490, 460, 435, 415].map((d) => engine.addCar('norte', d).id)
      runFor(engine, 20_000) // green at 38 s
      const started: (number | undefined)[] = []
      const reached: (number | undefined)[] = []
      for (let tick = 1; tick <= 250; tick++) {
        engine.tick(TICK_MS)
        const ds: number[] = []
        ids.forEach((id, i) => {
          const c = car(engine, id)!
          ds.push(c.distance)
          if (started[i] === undefined && c.velocity > 0.01) started[i] = tick
          if (reached[i] === undefined && c.velocity * 3.6 > 30) reached[i] = tick
        })
        for (let i = 1; i < ds.length; i++) expect(ds[i - 1]).toBeGreaterThan(ds[i])
      }
      for (let i = 1; i < ids.length; i++) expect(started[i]!).toBeGreaterThan(started[i - 1]!)
      for (const r of reached) expect(r).toBeDefined()
    })

    it('cars of different routes queue together on the shared arrival stretch', () => {
      const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      // central stopped 60 m past the junction; a north car enters the stretch at 50 km/h
      const central = engine.addCar('central', lengths.central - SHARED_M + 60, 0).id
      const norte = engine.addCar('norte', lengths.norte - SHARED_M).id
      let minVel = Infinity
      runFor(engine, 10_000, () => {
        const c = car(engine, central)
        const n = car(engine, norte)
        if (!c || !n) return
        const [sc, xc] = stretch(c.routeId, c.distance)
        const [sn, xn] = stretch(n.routeId, n.distance)
        expect(sc).toBe('chegada')
        expect(sn).toBe('chegada')
        expect(xc - xn).toBeGreaterThanOrEqual(7 - 1e-9)
        minVel = Math.min(minVel, n.velocity)
      })
      // the north car had to brake for a car of another route
      expect(minVel * 3.6).toBeLessThan(40)

      // at the origin each route has its own lane: a stopped central car does not block the north
      const lanes = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
      lanes.addCar('central', 60, 0)
      const free = lanes.addCar('norte', 30).id
      runFor(lanes, 3_000, () => expect(car(lanes, free)!.velocity).toBeCloseTo(FREE_MS, 9))
    })

    it('the car farther from the arrival junction yields and nobody is closer than 7 m after it', () => {
      const check = (farRoute: string, farGap: number, nearRoute: string, nearGap: number) => {
        const engine = new SimulationEngine({ ratePerMinute: 0, trafficLights: 'always-green' })
        const far = engine.addCar(farRoute, lengths[farRoute] - SHARED_M - farGap).id
        const near = engine.addCar(nearRoute, lengths[nearRoute] - SHARED_M - nearGap).id
        let order: number[] | null = null
        let farWhenNearMerged: number | null = null
        runFor(engine, 12_000, () => {
          const f = car(engine, far)
          const n = car(engine, near)
          if (!f || !n) return
          // the yielding is done before the junction: when the nearer car crosses it, the farther
          // one is still at least 7 m away from it
          const [snNow] = stretch(n.routeId, n.distance)
          if (snNow === 'chegada' && farWhenNearMerged === null) {
            const [sfNow, xfNow] = stretch(f.routeId, f.distance)
            farWhenNearMerged = sfNow === 'chegada' ? -xfNow : lengths[f.routeId] - SHARED_M - f.distance
          }
          const [sf, xf] = stretch(f.routeId, f.distance)
          const [sn, xn] = stretch(n.routeId, n.distance)
          if (sf === 'chegada' && sn === 'chegada') {
            expect(Math.abs(xn - xf)).toBeGreaterThanOrEqual(7 - 1e-9)
            order ??= xn > xf ? [near, far] : [far, near]
          }
        })
        expect(farWhenNearMerged).not.toBeNull()
        expect(farWhenNearMerged!).toBeGreaterThanOrEqual(7 - 1e-9 - (13.9 * TICK_MS) / 1000)
        return { order, near, far }
      }
      // central is 30 m from the junction, norte 25 m: central yields
      const r1 = check('central', 30, 'norte', 25)
      expect(r1.order).toEqual([r1.near, r1.far])
      // tie at 20 m: the alphabetically greater route (sul) yields to central
      const r2 = check('sul', 20, 'central', 20)
      expect(r2.order).toEqual([r2.near, r2.far])
    })

    it('holds generated cars at the origin until there is room and loses none', () => {
      const engine = new SimulationEngine({ ratePerMinute: 600 })
      let worst = Infinity
      runFor(engine, 60_000, () => {
        worst = Math.min(worst, minGap(engine))
        // entry as soon as there is room: a lane with cars waiting always has a car in its first 7 m
        const st = engine.getState()
        for (const [route, waiting] of Object.entries(st.waitingByRoute)) {
          if (waiting === 0) continue
          const first = Math.min(...st.cars.filter((c) => c.routeId === route).map((c) => c.distance))
          expect(first, `${route} lane`).toBeLessThan(7)
        }
      })
      const s = engine.getState()
      expect(s.spawnedTotal).toBe(600)
      expect(s.cars.length + s.arrivedTotal).toBeGreaterThan(50)
      expect(s.waitingAtOrigin).toBeGreaterThan(0)
      expect(s.cars.length + s.arrivedTotal + s.waitingAtOrigin).toBe(600)
      expect(worst).toBeGreaterThanOrEqual(7 - 1e-9)
    })
  })
})
