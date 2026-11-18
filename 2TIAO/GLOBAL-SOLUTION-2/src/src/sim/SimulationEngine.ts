import { DroneSensor, type Observation, type Reading } from '../telemetry/DroneSensor'
import { positionOnRoute, routeLength } from './car'
import { CarGenerator, DEFAULT_CAR_SPEED } from './carGenerator'
import { mulberry32 } from './random'
import { buildRoadNetwork } from './roadNetwork'
import { lightAt, type LightState } from './trafficLight'
import type { Car, Drone, Point, RoadNetwork, Route } from './types'

export const TICK_MS = 100
export const DEFAULT_RATE_PER_MINUTE = 30
/** Stop line, metres before the intersection centre. */
export const STOP_LINE_M = 12
/** Minimum distance kept to the car ahead on the same route. */
export const QUEUE_GAP_M = 8
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
  addCar(routeId: string, distance: number): CarState {
    const car: CarState = { id: this.manualId++, routeId, distance, speed: this.speed, velocity: 0 }
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
  tick(dtMs: number): void {
    const dt = dtMs / 1000
    const phase = new Map(this.lights(this.timeMs).map((l) => [l.intersectionId, l.phase]))

    const byRoute = new Map<string, CarState[]>()
    for (const car of this.cars) {
      const list = byRoute.get(car.routeId) ?? []
      list.push(car)
      byRoute.set(car.routeId, list)
    }

    const moved: CarState[] = []
    for (const [routeId, cars] of byRoute) {
      cars.sort((a, b) => b.distance - a.distance)
      const stops = this.stopLines.get(routeId) ?? []
      let leaderBefore: number | undefined
      for (const car of cars) {
        const before = car.distance
        let limit = leaderBefore === undefined ? Infinity : leaderBefore - QUEUE_GAP_M
        const next = stops.find((s) => s.at >= before - 1e-9)
        if (next && phase.get(next.intersectionId) === 'vermelho') limit = Math.min(limit, next.at)
        const after = Math.max(before, Math.min(before + car.speed * dt, limit))
        moved.push({ ...car, distance: after, velocity: (after - before) / dt })
        leaderBefore = before
      }
    }

    this.cars = moved.filter((car) => car.distance < (this.lengths.get(car.routeId) ?? 0) - 1e-9)
    const spawned = this.generator.tick(dtMs, this.network.routes)
    this.spawnedTotal += spawned.length
    this.cars.push(...spawned.map((c) => ({ ...c, velocity: 0 })))
    this.timeMs += dtMs

    const readings = this.sensor.observe(dtMs, this.timeMs, this.drones, this.observations())
    for (const r of readings) for (const l of this.readingListeners) l(r)
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
      timeMs: this.timeMs,
      lights: this.lights(this.timeMs),
      drones: this.drones,
      noisePct: this.sensor.getNoise(),
    }
  }
}
