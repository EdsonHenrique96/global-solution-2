import { describe, expect, it } from 'vitest'
import { fromLngLat, project, toLngLat } from '../sensors/geo'
import { buildSegments } from '../sensors/segments'
import { borderIds, buildCityNetwork } from './cityNetwork'
import { shortestPath } from './graph'
import { QUEUE_SPEED_MS, SimulationEngine, STOP_LINE_M, TICK_MS, type Arrival } from './SimulationEngine'
import { CYCLE_MS, lightAt, SignalController } from './trafficLight'

const NAMES = [
  ['Al. Santos', 'Al. Jaú', 'Al. Itu', 'Al. Franca'],
  ['R. da Consolação', 'R. Bela Cintra', 'R. Haddock Lobo', 'R. Augusta'],
]

/** An engine with no generated traffic and no sensors, for placed cars. */
const quiet = () => new SimulationEngine({ ratePerMinute: 0, cameras: [] })

describe('city', () => {
  describe('network', () => {
    it('builds the 16 named corners and 48 directed segments', () => {
      const network = buildCityNetwork()
      expect(network.intersections.map((i) => i.id)).toEqual(
        [1, 2, 3, 4].flatMap((r) => [1, 2, 3, 4].map((c) => `I${r}${c}`)),
      )
      for (const i of network.intersections) expect(i.nome).toBe(`${NAMES[0][i.row - 1]} × ${NAMES[1][i.col - 1]}`)
      const segments = buildSegments(network)
      expect(segments).toHaveLength(48)
      expect(new Set(segments.map((s) => s.id)).size).toBe(48)
      for (const s of segments) {
        expect(s.length).toBeGreaterThanOrEqual(80)
        expect(s.length).toBeLessThanOrEqual(300)
        const [a, b] = [network.intersections.find((i) => i.id === s.from)!, network.intersections.find((i) => i.id === s.to)!]
        // neighbours: same alameda and next rua, or same rua and next alameda
        expect(Math.abs(a.row - b.row) + Math.abs(a.col - b.col)).toBe(1)
      }
      const ids = segments.map((s) => s.id)
      expect(ids).toContain('I11>I12')
      expect(ids).toContain('I12>I11')
      expect(ids).not.toContain('I11>I22')
    })

    it('projects the real corners to metres with north up', () => {
      const network = buildCityNetwork()
      for (const i of network.intersections) {
        expect(i.lat).toBeGreaterThan(-23.575)
        expect(i.lat).toBeLessThan(-23.555)
        expect(i.lng).toBeGreaterThan(-46.67)
        expect(i.lng).toBeLessThan(-46.65)
        const p = project(i.lat, i.lng)
        expect(i.position.x).toBeCloseTo(p.x, 6)
        expect(i.position.y).toBeCloseTo(p.y, 6)
        const back = fromLngLat(toLngLat(i.position))
        expect(back.x).toBeCloseTo(i.position.x, 6)
        expect(back.y).toBeCloseTo(i.position.y, 6)
      }
      const at = (id: string) => network.intersections.find((i) => i.id === id)!.position
      expect(at('I11').x).toBeCloseTo(0, 9)
      expect(at('I11').y).toBeCloseTo(0, 9)
      // Al. Franca is south of Al. Santos: y grows to the south
      expect(at('I41').y).toBeGreaterThan(at('I11').y)
      // one degree of latitude is ~110.6 km
      expect(project(-23.56652, -46.66405).y).toBeCloseTo(1105.74, 1)
    })
  })

  describe('paths', () => {
    it('draws seeded distinct border pairs and follows the shortest path', () => {
      const segments = buildSegments(buildCityNetwork())
      expect(shortestPath(segments, 'I11', 'I14')).toEqual(['I11>I12', 'I12>I13', 'I13>I14'])

      const trips = (seed: number) => {
        const e = new SimulationEngine({ ratePerMinute: 120, seed, cameras: [] })
        const seen = new Map<number, { entrada: string; saida: string; path: string[] }>()
        for (let t = 0; t < 30_000; t += TICK_MS) {
          e.tick(TICK_MS)
          for (const c of [...e.waitingCars(), ...e.getState().cars]) if (!seen.has(c.id)) seen.set(c.id, { entrada: c.entrada, saida: c.saida, path: [...c.path] })
        }
        return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
      }
      const a = trips(1001)
      expect(a.length).toBeGreaterThanOrEqual(50)
      expect(trips(1001)).toEqual(a)
      expect(trips(1002).map((t) => `${t.entrada}-${t.saida}`)).not.toEqual(a.map((t) => `${t.entrada}-${t.saida}`))
      const borders = new Set(borderIds(buildCityNetwork()))
      for (const t of a) {
        expect(borders.has(t.entrada)).toBe(true)
        expect(borders.has(t.saida)).toBe(true)
        expect(t.entrada).not.toBe(t.saida)
        expect(t.path).toEqual(shortestPath(segments, t.entrada, t.saida))
      }
    })
  })

  describe('engine', () => {
    it('stops before the stop line on red and queues without collision', () => {
      const e = quiet()
      // wait for I13 to turn red for the alameda (V green with at least 18 s left)
      while (!(lightAt('I13', e.getState().timeMs).v === 'verde' && lightAt('I13', e.getState().timeMs).remainingS >= 18)) e.tick(TICK_MS)
      const path = ['I12>I13', 'I13>I14']
      const line = e.segment('I12>I13')!.length - STOP_LINE_M
      e.addCar({ path, distance: 40 })
      e.addCar({ path, distance: 20 })
      e.addCar({ path, distance: 0 })
      for (let t = 0; t < 15_000; t += TICK_MS) {
        e.tick(TICK_MS)
        const cars = [...e.getState().cars].sort((x, y) => y.distance - x.distance)
        expect(cars).toHaveLength(3)
        for (const c of cars) expect(c.path[c.seg]).toBe('I12>I13')
        expect(cars[0].distance).toBeLessThanOrEqual(line + 1e-9)
        for (let i = 1; i < cars.length; i++) expect(cars[i - 1].distance - cars[i].distance - 5).toBeGreaterThan(0)
      }
      const cars = [...e.getState().cars].sort((x, y) => y.distance - x.distance)
      // stopped as the project counts a queue: under 5 km/h
      for (const c of cars) expect(c.velocity).toBeLessThan(QUEUE_SPEED_MS)
      expect(line - cars[0].distance).toBeLessThanOrEqual(2)
    })

    it('removes a car at the end of its path and reports the arrival', () => {
      const e = quiet()
      const arrivals: Arrival[] = []
      e.onArrival((a) => arrivals.push(a))
      const car = e.addCar({ path: ['I13>I14'], distance: 50 })
      const L = e.segment('I13>I14')!.length
      for (let t = 0; t < 30_000 && arrivals.length === 0; t += TICK_MS) e.tick(TICK_MS)
      expect(e.getState().cars).toHaveLength(0)
      expect(arrivals).toHaveLength(1)
      expect(arrivals[0].carId).toBe(car.id)
      expect(arrivals[0].travelS).toBeGreaterThan(0)
      expect(arrivals[0].distanciaM).toBeGreaterThanOrEqual(L - 50 - 1e-6)
      expect(arrivals[0].co2G).toBeGreaterThan(0)
    })

    it('runs 15 minutes without gridlock', { timeout: 60_000 }, () => {
      const e = new SimulationEngine({ ratePerMinute: 15, seed: 1001, arrivals: 'poisson' })
      const arrived = new Set<number>()
      e.onArrival((a) => arrived.add(a.carId))
      const still = new Map<number, number>()
      let maxStillMs = 0
      let bornBy10min = 0
      for (let t = TICK_MS; t <= 900_000; t += TICK_MS) {
        e.tick(TICK_MS)
        if (t === 600_000) bornBy10min = e.getState().spawnedTotal
        for (const c of e.getState().cars) {
          const s = c.velocity < 0.1 ? (still.get(c.id) ?? 0) + TICK_MS : 0
          still.set(c.id, s)
          maxStillMs = Math.max(maxStillMs, s)
        }
      }
      expect(bornBy10min).toBeGreaterThan(100)
      // generated cars get ids 1, 2, ... in order
      for (let id = 1; id <= bornBy10min; id++) expect(arrived.has(id)).toBe(true)
      expect(maxStillMs).toBeLessThanOrEqual(120_000)
    })

    it('blocks a point of a segment for 2 simulated minutes', () => {
      const e = quiet()
      const events: { ativo: boolean; ts: number }[] = []
      e.onBlockage(({ ativo, ts }) => events.push({ ativo, ts }))
      e.setAdaptiveSignals(false)
      const b = e.addBlockage('I12>I13', 80)
      const car = e.addCar({ path: ['I12>I13', 'I13>I14'], distance: 0 })
      for (let t = 0; t < 119_000; t += TICK_MS) {
        e.tick(TICK_MS)
        const c = e.getState().cars.find((x) => x.id === car.id)!
        expect(c.path[c.seg]).toBe('I12>I13')
        expect(c.distance).toBeLessThan(80 - 5)
      }
      expect(e.getState().blockages.map((x) => x.id)).toEqual([b.id])
      for (let t = 0; t < 1_000; t += TICK_MS) e.tick(TICK_MS)
      expect(e.getState().blockages).toHaveLength(0)
      expect(events).toEqual([
        { ativo: true, ts: 0 },
        { ativo: false, ts: 120_000 },
      ])
      // traffic resumes: the car gets past the point
      for (let t = 0; t < 60_000; t += TICK_MS) e.tick(TICK_MS)
      const c = e.getState().cars.find((x) => x.id === car.id)
      expect(c === undefined || c.seg > 0 || c.distance > 80).toBe(true)
    })
  })

  describe('signals', () => {
    it('never shows green on both phases of an intersection', () => {
      const ids = buildCityNetwork().intersections.map((i) => i.id)
      const exclusive = (h: string, v: string) => {
        expect(h === 'verde' && v === 'verde').toBe(false)
        // exactly one phase is open (green or yellow) at any time
        expect((h !== 'vermelho') !== (v !== 'vermelho')).toBe(true)
      }
      for (const id of ids) {
        const opened = new Set<string>()
        for (let t = 0; t < CYCLE_MS; t += TICK_MS) {
          const l = lightAt(id, t)
          exclusive(l.h, l.v)
          if (l.h === 'verde') opened.add('H')
          if (l.v === 'verde') opened.add('V')
        }
        expect([...opened].sort()).toEqual(['H', 'V'])
      }
      // adaptive, with uneven queues, over 5 minutes
      const c = new SignalController(ids)
      c.setAdaptive(true, 0)
      for (let t = 0; t <= 300_000; t += TICK_MS) {
        c.advance(t, (id, axis) => (axis === 'H' ? Number(id[2]) * 3 : Number(id[1])))
        for (const l of c.lights(t)) exclusive(l.h, l.v)
      }
    })
  })
})
