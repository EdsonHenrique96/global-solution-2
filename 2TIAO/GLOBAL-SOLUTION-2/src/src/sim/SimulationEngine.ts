import { DroneSensor, type Observation, type Reading } from '../telemetry/DroneSensor'
import { positionOnRoute, routeLength } from './car'
import { CarGenerator, DEFAULT_CAR_SPEED } from './carGenerator'
import { mulberry32 } from './random'
import { IDM, idmAcceleration, LOOKAHEAD_M, MAX_STOP_DECEL, step } from './idm'
import { buildRoadNetwork } from './roadNetwork'
import { lightAt, type LightState } from './trafficLight'
import type { Car, Drone, Point, RoadNetwork, Route } from './types'

export const TICK_MS = 100
export const DEFAULT_RATE_PER_MINUTE = 30
/** Stop line, metres before the intersection centre. */
export const STOP_LINE_M = 12
/** Length of the entrance lanes (origin -> fork) and of the shared arrival stretch (junction -> destination). */
export const SHARED_M = 120
/** Distance before the arrival junction where cars of different routes start to zip. */
export const MERGE_ZONE_M = 80
const ORIGIN_EDGE = 'origem'
const ARRIVAL_EDGE = 'chegada'
export const DRONE_RADIUS_M = 110

export const DEFAULT_DRONES: readonly Drone[] = [
  { id: 'D1', position: { x: 500, y: 120 }, radius: DRONE_RADIUS_M },
  { id: 'D2', position: { x: 500, y: 300 }, radius: DRONE_RADIUS_M },
  { id: 'D3', position: { x: 500, y: 480 }, radius: DRONE_RADIUS_M },
]

/** A car plus its instantaneous speed (m/s, 0 when stopped). */
export interface CarState extends Car {
  velocity: number
}

export interface SimulationState {
  network: RoadNetwork
  cars: readonly CarState[]
  /** Cars generated since start; arrivals do not decrease it. */
  spawnedTotal: number
  ratePerMinute: number
  /** Generated cars still waiting for room at the origin. */
  waitingAtOrigin: number
  /** Cars that reached the destination. */
  arrivedTotal: number
  timeMs: number
  lights: readonly LightState[]
  drones: readonly Drone[]
  noisePct: number
}

export interface SimulationOptions {
  ratePerMinute?: number
  speed?: number
  /** 'fixed' runs the fixed-time cycle; 'always-green' never stops a car. */
  trafficLights?: 'fixed' | 'always-green'
  drones?: readonly Drone[]
  noisePct?: number
  seed?: number
}

interface StopLine {
  intersectionId: string
  at: number
}

/** Distance along the route of the polyline point closest to `p`. */
function distanceAlong(route: Route, p: Point): number {
  let best = Infinity
  let bestAt = 0
  let walked = 0
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1]
    const b = route.points[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len)))
    const d = Math.hypot(a.x + (b.x - a.x) * t - p.x, a.y + (b.y - a.y) * t - p.y)
    if (d < best) {
      best = d
      bestAt = walked + len * t
    }
    walked += len
  }
  return bestAt
}

export class SimulationEngine {
  private readonly network: RoadNetwork
  private readonly generator: CarGenerator
  private readonly lengths: Map<string, number>
  private readonly stopLines: Map<string, StopLine[]>
  private readonly lightMode: 'fixed' | 'always-green'
  private readonly sensor: DroneSensor
  private readonly speed: number
  private readonly readingListeners = new Set<(r: Reading) => void>()
  private cars: CarState[] = []
  private drones: Drone[]
  private spawnedTotal = 0
  private arrivedTotal = 0
  private waiting: Car[] = []
  /** Cars that met a red too close to stop, by the intersection they are going through. */
  private readonly committed = new Map<number, string>()
  private timeMs = 0
  private manualId = 1_000_000

  constructor(options: SimulationOptions = {}) {
    this.network = buildRoadNetwork()
    this.speed = options.speed ?? DEFAULT_CAR_SPEED
    this.generator = new CarGenerator(options.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE, this.speed)
    this.lengths = new Map(this.network.routes.map((r) => [r.id, routeLength(r)]))
    const positions = new Map(this.network.intersections.map((i) => [i.id, i.position]))
    this.stopLines = new Map(
      this.network.routes.map((r) => [
        r.id,
        r.intersectionIds
          .map((id) => ({ intersectionId: id, at: distanceAlong(r, positions.get(id)!) - STOP_LINE_M }))
          .sort((a, b) => a.at - b.at),
      ]),
    )
    this.lightMode = options.trafficLights ?? 'fixed'
    this.drones = (options.drones ?? DEFAULT_DRONES).map((d) => ({ ...d, position: { ...d.position } }))
    this.sensor = new DroneSensor({
      noisePct: options.noisePct,
      rng: mulberry32(options.seed ?? 42),
      routes: this.network.routes,
    })
  }

  setRate(ratePerMinute: number): void {
    this.generator.setRate(ratePerMinute)
  }

  getRate(): number {
    return this.generator.getRate()
  }

  setNoise(pct: number): void {
    this.sensor.setNoise(pct)
  }

  getNoise(): number {
    return this.sensor.getNoise()
  }

  /** Moves a drone, clamped to the map area. */
  moveDrone(id: string, to: Point): void {
    const drone = this.drones.find((d) => d.id === id)
    if (!drone) return
    drone.position = {
      x: Math.min(this.network.width, Math.max(0, to.x)),
      y: Math.min(this.network.height, Math.max(0, to.y)),
    }
  }

  /** Places a car on a route (scenario setup; the generator places cars at the origin). */
  addCar(routeId: string, distance: number, velocity: number = this.speed): CarState {
    const car: CarState = { id: this.manualId++, routeId, distance, speed: this.speed, velocity }
    this.cars.push(car)
    return car
  }

  onReading(listener: (r: Reading) => void): () => void {
    this.readingListeners.add(listener)
    return () => this.readingListeners.delete(listener)
  }

  private lights(timeMs: number): LightState[] {
    return this.network.intersections.map((i) =>
      this.lightMode === 'always-green'
        ? { intersectionId: i.id, phase: 'verde', remainingS: Infinity }
        : lightAt(i.id, timeMs),
    )
  }

  /**
   * One step: lights as they stand at the start of the tick decide who stops; each car keeps
   * QUEUE_GAP_M behind where the car ahead was at the start of the tick, so a queue releases
   * one car per tick, leader first. Then arrivals leave, new cars spawn and the drones sample.
   */
  /**
   * Physical stretch a car is on and its position along it: each route's own entrance lane
   * (AD-010), its middle stretch, or the arrival stretch every route shares.
   */
  private place(routeId: string, d: number): { edge: string; x: number; length: number } {
    const L = this.lengths.get(routeId) ?? 0
    if (d <= SHARED_M) return { edge: `${ORIGIN_EDGE}:${routeId}`, x: d, length: SHARED_M }
    if (d >= L - SHARED_M) return { edge: ARRIVAL_EDGE, x: d - (L - SHARED_M), length: SHARED_M }
    return { edge: routeId, x: d - SHARED_M, length: L - 2 * SHARED_M }
  }

  private nextEdge(edge: string, routeId: string): string | null {
    if (edge.startsWith(ORIGIN_EDGE)) return routeId
    if (edge === ARRIVAL_EDGE) return null
    return ARRIVAL_EDGE
  }

  /**
   * One step. Everything a car reacts to is read from the start of the tick (synchronous update):
   * the car ahead on its physical stretch or the next one on its route, the stop line of a red
   * light it can still stop for, and near the arrival junction a car of another route that is
   * closer to it. Then arrivals leave, waiting cars enter at the origin and the drones sample.
   */
  tick(dtMs: number): void {
    const dt = dtMs / 1000
    const phase = new Map(this.lights(this.timeMs).map((l) => [l.intersectionId, l.phase]))

    const placed = this.cars.map((car) => ({ car, ...this.place(car.routeId, car.distance) }))
    const byEdge = new Map<string, typeof placed>()
    for (const p of placed) {
      const list = byEdge.get(p.edge)
      if (list) list.push(p)
      else byEdge.set(p.edge, [p])
    }
    // order along each stretch; equal positions by id so every car has one well-defined leader
    const rank = new Map<(typeof placed)[number], number>()
    for (const list of byEdge.values()) {
      list.sort((a, b) => a.x - b.x || b.car.id - a.car.id)
      list.forEach((p, i) => rank.set(p, i))
    }
    // cars close to the arrival junction on a middle stretch, for the zipper
    const zipping = placed
      .filter((p) => !p.edge.startsWith(ORIGIN_EDGE) && p.edge !== ARRIVAL_EDGE && p.length - p.x <= MERGE_ZONE_M)
      .map((p) => ({ edge: p.edge, routeId: p.car.routeId, d: p.length - p.x, v: p.car.velocity }))

    const moved: CarState[] = []
    for (const me of placed) {
      const { car } = me
      // bumper gap and speed of whatever is ahead, nearest first
      let gap = Infinity
      let leadV = 0
      const consider = (g: number, v: number) => {
        if (g < gap && g <= LOOKAHEAD_M) {
          gap = g
          leadV = v
        }
      }

      const same = byEdge.get(me.edge)!
      const ahead = same[rank.get(me)! + 1]
      if (ahead) {
        consider(ahead.x - me.x - IDM.length, ahead.car.velocity)
      } else {
        const next = this.nextEdge(me.edge, car.routeId)
        const first = next ? byEdge.get(next)?.[0] : undefined
        if (first) consider(me.length - me.x + first.x - IDM.length, first.car.velocity)
      }

      // zipper at the arrival junction: yield to a closer car of another route
      const mine = me.length - me.x
      if (!me.edge.startsWith(ORIGIN_EDGE) && me.edge !== ARRIVAL_EDGE && mine <= MERGE_ZONE_M) {
        let best: { d: number; v: number } | null = null
        for (const other of zipping) {
          if (other.edge === me.edge) continue
          const before = other.d < mine || (other.d === mine && other.routeId < car.routeId)
          if (before && (best === null || other.d > best.d)) best = other
        }
        if (best) consider(mine - best.d - IDM.length, best.v)
      }

      // red light: stop if it can with a firm brake, otherwise commit and go through
      let lineRoom = Infinity
      const stop = (this.stopLines.get(car.routeId) ?? []).find((sl) => sl.at >= car.distance - 1e-9)
      if (stop && phase.get(stop.intersectionId) === 'vermelho') {
        const toLine = stop.at - car.distance
        const committed = this.committed.get(car.id) === stop.intersectionId
        const needed = (car.velocity * car.velocity) / (2 * Math.max(toLine, 0.01))
        if (!committed && needed > MAX_STOP_DECEL) {
          this.committed.set(car.id, stop.intersectionId)
        } else if (!committed) {
          lineRoom = toLine
          consider(toLine + IDM.s0, 0)
        }
      } else if (stop) {
        this.committed.delete(car.id)
      }

      const acc = idmAcceleration(car.velocity, car.speed, gap, car.velocity - leadV)
      const room = Math.min(Number.isFinite(gap) ? gap - IDM.s0 : Infinity, lineRoom)
      const next = step(car.distance, car.velocity, acc, car.speed, dt, room)
      moved.push({ ...car, distance: next.x, velocity: next.v })
    }

    const stillIn: CarState[] = []
    for (const car of moved) {
      if (car.distance < (this.lengths.get(car.routeId) ?? 0) - 1e-9) stillIn.push(car)
      else {
        this.arrivedTotal += 1
        this.committed.delete(car.id)
      }
    }
    this.cars = stillIn

    const spawned = this.generator.tick(dtMs, this.network.routes)
    this.spawnedTotal += spawned.length
    this.waiting.push(...spawned)
    this.admitWaiting()
    this.timeMs += dtMs

    const readings = this.sensor.observe(dtMs, this.timeMs, this.drones, this.observations())
    for (const r of readings) for (const l of this.readingListeners) l(r)
  }

  /** The first waiting car enters at the origin when there are 7 m free, as fast as is safe. */
  private admitWaiting(): void {
    if (this.waiting.length === 0) return
    // FIFO per entrance stretch: one car per stretch per tick, when the first car on it is 7 m in
    const done = new Set<string>()
    const remaining: Car[] = []
    for (const car of this.waiting) {
      const edge = this.place(car.routeId, 0).edge
      if (done.has(edge)) {
        remaining.push(car)
        continue
      }
      done.add(edge)
      let last = Infinity
      let lastV = 0
      for (const other of this.cars) {
        const p = this.place(other.routeId, other.distance)
        if (p.edge === edge && p.x < last) {
          last = p.x
          lastV = other.velocity
        }
      }
      if (last < IDM.length + IDM.s0) {
        remaining.push(car)
        continue
      }
      // enter at the highest speed whose IDM response to the car ahead is no harder than -b
      let v = car.speed
      if (Number.isFinite(last)) {
        const gap = last - IDM.length
        while (v > 0 && idmAcceleration(v, car.speed, gap, v - lastV) < -IDM.b) v = Math.max(0, v - 0.25)
      }
      this.cars.push({ ...car, velocity: v })
    }
    this.waiting = remaining
  }


  private observations(): Observation[] {
    const routes = new Map(this.network.routes.map((r) => [r.id, r]))
    return this.cars.map((car) => {
      const p = positionOnRoute(routes.get(car.routeId)!, car.distance)
      return { x: p.x, y: p.y, speedKmh: car.velocity * 3.6, via: car.routeId }
    })
  }

  getState(): SimulationState {
    return {
      network: this.network,
      cars: this.cars,
      spawnedTotal: this.spawnedTotal,
      ratePerMinute: this.generator.getRate(),
      waitingAtOrigin: this.waiting.length,
      arrivedTotal: this.arrivedTotal,
      timeMs: this.timeMs,
      lights: this.lights(this.timeMs),
      drones: this.drones,
      noisePct: this.sensor.getNoise(),
    }
  }
}
