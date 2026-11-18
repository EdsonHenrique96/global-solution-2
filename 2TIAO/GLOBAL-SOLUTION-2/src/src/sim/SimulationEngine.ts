import { DEFAULT_CAMERAS, type FixedCamera } from '../sensors/camera'
import { CoverageIndex } from '../sensors/coverage'
import { SensorReader, type CarSample, type Reading } from '../sensors/reader'
import { buildSegments, segmentAt, SHARED_M, type Segment } from '../sensors/segments'
import { distanceAlongRoute, positionOnRoute, routeLength } from './car'
import { CarGenerator, DEFAULT_CAR_SPEED } from './carGenerator'
import { mulberry32 } from './random'
import { stepEmission } from '../experiments/emission'
import { IDM, idmAcceleration, LOOKAHEAD_M, MAX_DECEL, MAX_STOP_DECEL, step, yieldDeceleration } from './idm'
import { buildRoadNetwork } from './roadNetwork'
import { SignalController, type LightState } from './trafficLight'
import type { Car, Point, RoadNetwork } from './types'

export const TICK_MS = 100
export const DEFAULT_RATE_PER_MINUTE = 30
/** Stop line, metres before the intersection centre. */
export const STOP_LINE_M = 12
export { SHARED_M }
/** Distance before the arrival junction where cars of different routes start to zip. */
export const MERGE_ZONE_M = 150
const ORIGIN_EDGE = 'origem'
const ARRIVAL_EDGE = 'chegada'
/** A car plus its instantaneous speed (m/s, 0 when stopped) and what it has emitted so far. */
export interface CarState extends Car {
  velocity: number
  /** CO2 emitted so far, g. */
  co2G: number
  /** Distance driven so far, m. */
  traveledM: number
  /** Time spent standing (under 5 km/h), s. */
  stoppedS: number
}

/** A stopped obstacle on a road (accident, AD-016). */
export interface Blockage {
  id: number
  routeId: string
  distance: number
  endsAtMs: number
}

/** Cars bound for `from` that have not entered yet go to `to` with probability `fraction`. */
export interface Diversion {
  from: string
  to: string
  fraction: number
}

export interface Arrival {
  carId: number
  routeId: string
  atMs: number
  travelS: number
  co2G: number
  distanciaM: number
  paradoS: number
}

export const BLOCKAGE_MS = 120_000
/** Below this speed a car counts as queued. */
export const QUEUE_SPEED_MS = 5 / 3.6
/** How far before a stop line a light's queue is measured. */
export const QUEUE_REACH_M = 150

export interface SimulationState {
  network: RoadNetwork
  cars: readonly CarState[]
  /** Cars generated since start; arrivals do not decrease it. */
  spawnedTotal: number
  ratePerMinute: number
  /** Generated cars still waiting for room at the origin. */
  waitingAtOrigin: number
  waitingByRoute: Record<string, number>
  /** Cars that reached the destination. */
  arrivedTotal: number
  timeMs: number
  lights: readonly LightState[]
  cameras: readonly FixedCamera[]
  segments: readonly Segment[]
  noisePct: number
  blockages: readonly Blockage[]
  diversion: Diversion | null
  /** Cars sent to another route by a diversion. */
  divertedTotal: number
  /** Generated cars by the route they will take (on the road, arrived or waiting). */
  routeTotals: Record<string, number>
  adaptiveSignals: boolean
  /** CO2 emitted by every car since start, g. */
  co2TotalG: number
  /** Distance driven by every car since start, m. */
  distanceTotalM: number
}

export interface SimulationOptions {
  ratePerMinute?: number
  speed?: number
  /** 'fixed' runs the fixed-time cycle; 'always-green' never stops a car. */
  trafficLights?: 'fixed' | 'always-green'
  /** Fixed cameras; [] for a map without sensors. */
  cameras?: readonly FixedCamera[]
  noisePct?: number
  seed?: number
  /** 'deterministic' (default) spaces cars evenly; 'poisson' draws exponential gaps from the seed. */
  arrivals?: 'deterministic' | 'poisson'
}

interface StopLine {
  intersectionId: string
  at: number
}

export const CAMERA_LIMITS = { fovMin: 10, fovMax: 170, rangeMin: 20, rangeMax: 500 } as const
const NEW_CAMERA: Omit<FixedCamera, 'id'> = { position: { x: 500, y: 300 }, heading: 90, fov: 60, range: 200 }

function clampCamera(c: FixedCamera, previous: FixedCamera): FixedCamera {
  const num = (v: number, old: number) => (Number.isFinite(v) ? v : old)
  const heading = num(c.heading, previous.heading)
  return {
    ...c,
    heading: ((Math.round(heading) % 360) + 360) % 360,
    fov: Math.min(CAMERA_LIMITS.fovMax, Math.max(CAMERA_LIMITS.fovMin, num(c.fov, previous.fov))),
    range: Math.min(CAMERA_LIMITS.rangeMax, Math.max(CAMERA_LIMITS.rangeMin, num(c.range, previous.range))),
  }
}

interface MergeTicket {
  atMs: number
  d: number
  routeId: string
}

/** Earlier entry first; same tick: closer to the junction first; then route name. */
function ticketBefore(a: MergeTicket, b: MergeTicket): boolean {
  if (a.atMs !== b.atMs) return a.atMs < b.atMs
  if (a.d !== b.d) return a.d < b.d
  return a.routeId < b.routeId
}

export class SimulationEngine {
  private readonly network: RoadNetwork
  private readonly generator: CarGenerator
  private readonly lengths: Map<string, number>
  private readonly stopLines: Map<string, StopLine[]>
  private readonly lightMode: 'fixed' | 'always-green'
  private readonly sensor: SensorReader
  private readonly segments: Segment[]
  readonly coverage: CoverageIndex
  private readonly speed: number
  private readonly readingListeners = new Set<(r: Reading) => void>()
  private cars: CarState[] = []
  private cameras: FixedCamera[]
  private nextCamera = 1
  private spawnedTotal = 0
  private arrivedTotal = 0
  private waiting: Car[] = []
  /** Junction order: each car's ticket from the moment it entered the merge zone. */
  private readonly mergeTickets = new Map<number, MergeTicket>()
  /** Each car's stop-or-go decision for the red light ahead of it. */
  private readonly redDecision = new Map<number, { intersectionId: string; go: boolean }>()
  private timeMs = 0
  private manualId = 1_000_000
  private readonly signals: SignalController
  private blockages: Blockage[] = []
  private blockageId = 1
  private diversion: Diversion | null = null
  private diversionBudget = 0
  private lastPair: { from: string; to: string } | null = null
  /** Waiting cars already decided by the current diversion. */
  private readonly diversionDecided = new Set<number>()
  private divertedTotal = 0
  private readonly routeTotals: Record<string, number>
  private readonly arrivalListeners = new Set<(a: Arrival) => void>()
  private readonly blockageListeners = new Set<(e: { blockage: Blockage; ativo: boolean; ts: number }) => void>()
  private readonly arrivals: Arrival[] = []
  private travelSumS = 0
  private co2TotalG = 0
  private distanceTotalM = 0

  constructor(options: SimulationOptions = {}) {
    this.network = buildRoadNetwork()
    this.speed = options.speed ?? DEFAULT_CAR_SPEED
    this.generator = new CarGenerator(options.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE, this.speed, {
      arrivals: options.arrivals ?? 'deterministic',
      rng: mulberry32((options.seed ?? 42) * 7919 + 1),
    })
    this.lengths = new Map(this.network.routes.map((r) => [r.id, routeLength(r)]))
    const positions = new Map(this.network.intersections.map((i) => [i.id, i.position]))
    this.stopLines = new Map(
      this.network.routes.map((r) => [
        r.id,
        r.intersectionIds
          .map((id) => ({ intersectionId: id, at: distanceAlongRoute(r, positions.get(id)!) - STOP_LINE_M }))
          .sort((a, b) => a.at - b.at),
      ]),
    )
    this.lightMode = options.trafficLights ?? 'fixed'
    this.signals = new SignalController(this.network.intersections.map((i) => i.id))
    this.routeTotals = Object.fromEntries(this.network.routes.map((r) => [r.id, 0]))
    this.segments = buildSegments(this.network)
    this.cameras = (options.cameras ?? DEFAULT_CAMERAS).map((c) => ({ ...c, position: { ...c.position } }))
    this.coverage = new CoverageIndex(this.segments)
    this.coverage.setCameras(this.cameras)
    this.nextCamera = 1 + Math.max(0, ...this.cameras.map((c) => Number(c.id.replace(/\D/g, '')) || 0))
    this.sensor = new SensorReader({ noisePct: options.noisePct, rng: mulberry32(options.seed ?? 42) })
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

  /** Moves a camera, clamped to the map area; the coverage index follows. */
  moveCamera(id: string, to: Point): void {
    this.updateCamera(id, {
      position: {
        x: Math.min(this.network.width, Math.max(0, to.x)),
        y: Math.min(this.network.height, Math.max(0, to.y)),
      },
    })
  }

  /**
   * Changes a camera's position, heading, FOV or range, clamped to their limits (heading wraps to
   * 0-359, FOV 10-170, range 20-500, anything not a number keeps the old value); the coverage
   * index is rebuilt only when something changed.
   */
  updateCamera(id: string, change: Partial<Omit<FixedCamera, 'id'>>): void {
    const i = this.cameras.findIndex((c) => c.id === id)
    if (i === -1) return
    this.cameras[i] = clampCamera({ ...this.cameras[i], ...change, position: { ...(change.position ?? this.cameras[i].position) } }, this.cameras[i])
    this.coverage.updateCamera(this.cameras[i])
  }

  /** Adds the next camera (C4, C5, ... - ids are never reused) at the map centre. */
  addCamera(): FixedCamera {
    const camera: FixedCamera = { id: `C${this.nextCamera++}`, ...NEW_CAMERA, position: { ...NEW_CAMERA.position } }
    this.cameras.push(camera)
    this.coverage.setCameras(this.cameras)
    return camera
  }

  removeCamera(id: string): void {
    this.cameras = this.cameras.filter((c) => c.id !== id)
    this.coverage.setCameras(this.cameras)
  }

  /** Places a car on a route (scenario setup; the generator places cars at the origin). */
  addCar(routeId: string, distance: number, velocity: number = this.speed): CarState {
    const car: CarState = { id: this.manualId++, routeId, distance, speed: this.speed, velocity, bornAtMs: this.timeMs, co2G: 0, traveledM: 0, stoppedS: 0 }
    this.cars.push(car)
    return car
  }

  onReading(listener: (r: Reading) => void): () => void {
    this.readingListeners.add(listener)
    return () => this.readingListeners.delete(listener)
  }

  private lights(timeMs: number): LightState[] {
    if (this.lightMode === 'always-green') {
      return this.network.intersections.map((i) => ({ intersectionId: i.id, phase: 'verde', remainingS: Infinity }))
    }
    return this.signals.lights(timeMs)
  }

  /** The next green of a light, in seconds (adaptive control only). */
  setNextGreen(intersectionId: string, seconds: number): boolean {
    return this.signals.setNextGreen(intersectionId, seconds)
  }

  setAdaptiveSignals(on: boolean): void {
    this.signals.setAdaptive(on, this.timeMs)
  }

  /** Cars under 5 km/h in the 150 m before the light's stop line. */
  queueAt(intersectionId: string): number {
    let count = 0
    for (const car of this.cars) {
      const stop = this.stopLines.get(car.routeId)?.find((sl) => sl.intersectionId === intersectionId)
      if (!stop) continue
      if (car.distance <= stop.at + 1e-9 && car.distance >= stop.at - QUEUE_REACH_M && car.velocity < QUEUE_SPEED_MS) count += 1
    }
    return count
  }

  /** Slow cars on the road plus cars waiting at the origin. */
  queueTotal(): number {
    return this.cars.filter((c) => c.velocity < QUEUE_SPEED_MS).length + this.waiting.length
  }

  addBlockage(routeId: string, distance: number): Blockage {
    const b: Blockage = { id: this.blockageId++, routeId, distance, endsAtMs: this.timeMs + BLOCKAGE_MS }
    this.blockages.push(b)
    this.emitBlockage(b, true)
    return b
  }

  removeBlockage(id: number): void {
    const gone = this.blockages.filter((b) => b.id === id)
    this.blockages = this.blockages.filter((b) => b.id !== id)
    for (const b of gone) this.emitBlockage(b, false)
  }

  /** Accident started (ativo) or ended - by hand or after BLOCKAGE_MS. */
  onBlockage(listener: (e: { blockage: Blockage; ativo: boolean; ts: number }) => void): () => void {
    this.blockageListeners.add(listener)
    return () => this.blockageListeners.delete(listener)
  }

  private emitBlockage(blockage: Blockage, ativo: boolean): void {
    for (const l of this.blockageListeners) l({ blockage, ativo, ts: this.timeMs })
  }

  setDiversion(diversion: Diversion | null): void {
    // the fractional budget belongs to the pair A -> B: a window with p = 0 (null) keeps it, a
    // different pair starts over
    if (diversion && (diversion.from !== this.lastPair?.from || diversion.to !== this.lastPair?.to)) {
      this.diversionBudget = 0
      this.diversionDecided.clear()
      this.lastPair = { from: diversion.from, to: diversion.to }
    }
    this.diversion = diversion ? { ...diversion, fraction: Math.min(1, Math.max(0, diversion.fraction)) } : null
  }

  onArrival(listener: (a: Arrival) => void): () => void {
    this.arrivalListeners.add(listener)
    return () => this.arrivalListeners.delete(listener)
  }

  /** Mean travel time (s) of the cars that arrived in the last simulated minute, and since start. */
  travelStats(): { lastMinuteAvgS: number | null; allAvgS: number | null } {
    const since = this.timeMs - 60_000
    const recent = this.arrivals.filter((a) => a.atMs > since)
    return {
      lastMinuteAvgS: recent.length ? recent.reduce((s, a) => s + a.travelS, 0) / recent.length : null,
      allAvgS: this.arrivedTotal ? this.travelSumS / this.arrivedTotal : null,
    }
  }

  /** Where a blockage sits in a car's own route coordinate, if it is ahead on its path. */
  private blockageFor(routeId: string, b: Blockage): number | null {
    const at = this.place(b.routeId, b.distance)
    if (at.edge === ARRIVAL_EDGE) return (this.lengths.get(routeId) ?? 0) - SHARED_M + at.x
    return b.routeId === routeId ? b.distance : null
  }


  /**
   * One step: lights as they stand at the start of the tick decide who stops; each car keeps
   * QUEUE_GAP_M behind where the car ahead was at the start of the tick, so a queue releases
   * one car per tick, leader first. Then arrivals leave, new cars spawn and the sensors sample.
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
   * closer to it. Then arrivals leave, waiting cars enter at the origin and the sensors sample.
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
      .map((p) => ({ id: p.car.id, edge: p.edge, routeId: p.car.routeId, d: p.length - p.x, v: p.car.velocity }))

    // hand out junction tickets to cars entering the zone this tick, and drop the ones that left
    const inZone = new Set(zipping.map((z) => z.id))
    for (const id of [...this.mergeTickets.keys()]) if (!inZone.has(id)) this.mergeTickets.delete(id)
    for (const z of zipping) {
      if (!this.mergeTickets.has(z.id)) this.mergeTickets.set(z.id, { atMs: this.timeMs, d: z.d, routeId: z.routeId })
    }

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

      // zipper at the arrival junction: cars take a ticket when they enter the zone (entry time,
      // then distance to the junction, then route name) - one total order, so no cycle of cars
      // waiting for each other. A car brakes just enough to reach the junction one following
      // distance behind the car of another route with the closest earlier ticket.
      let accMerge = Infinity
      const mine = me.length - me.x
      const myTicket = this.mergeTickets.get(car.id)
      if (myTicket) {
        let binding: { d: number; v: number } | null = null
        let bindingTicket: MergeTicket | null = null
        for (const other of zipping) {
          if (other.edge === me.edge) continue
          const t = this.mergeTickets.get(other.id)
          if (!t || !ticketBefore(t, myTicket)) continue
          if (bindingTicket === null || ticketBefore(bindingTicket, t)) {
            bindingTicket = t
            binding = other
          }
        }
        if (binding) {
          const needed = yieldDeceleration(car.velocity, mine, binding.d, binding.v)
          if (needed >= IDM.b) accMerge = -needed
          else if (needed > 0) {
            // approach the waiting point (one following distance before the junction) like IDM
            // approaches a standing obstacle, instead of creeping with a tiny constant brake
            const waitAt = mine - (IDM.length + IDM.s0 + IDM.T * binding.v)
            accMerge = idmAcceleration(car.velocity, car.speed, Math.max(waitAt, 0) + IDM.s0, car.velocity)
          }
        }
      }

      // accidents: a standing obstacle ahead on this car's path
      let blockRoom = Infinity
      for (const b of this.blockages) {
        const at = this.blockageFor(car.routeId, b)
        if (at === null || at <= car.distance) continue
        const g = at - car.distance - IDM.length
        consider(g, 0)
        blockRoom = Math.min(blockRoom, g - IDM.s0)
      }

      // red light: decided once per light - stop if it can with at most 4.5 m/s², otherwise go
      // through; a car that stops brakes at the constant deceleration that ends exactly at the line
      // once that deceleration reaches the comfortable b
      let lineRoom = Infinity
      let accLine = Infinity
      const stop = (this.stopLines.get(car.routeId) ?? []).find((sl) => sl.at >= car.distance - 1e-9)
      if (stop && phase.get(stop.intersectionId) === 'vermelho') {
        const toLine = stop.at - car.distance
        const needed = (car.velocity * car.velocity) / (2 * Math.max(toLine, 0.01))
        let decision = this.redDecision.get(car.id)
        if (decision?.intersectionId !== stop.intersectionId) {
          decision = { intersectionId: stop.intersectionId, go: needed > MAX_STOP_DECEL }
          this.redDecision.set(car.id, decision)
        }
        if (!decision.go) {
          lineRoom = toLine
          if (needed >= IDM.b || toLine <= 0.5) accLine = -needed
        }
      } else {
        this.redDecision.delete(car.id)
      }

      const accLeader = idmAcceleration(car.velocity, car.speed, gap, car.velocity - leadV)
      const acc = Math.max(-MAX_DECEL, Math.min(accLeader, accLine, accMerge))
      const room = Math.min(Number.isFinite(gap) ? gap - IDM.s0 : Infinity, lineRoom, blockRoom)
      const next = step(car.distance, car.velocity, acc, car.speed, dt, room)
      const driven = next.x - car.distance
      const emitted = stepEmission(driven, dt)
      this.co2TotalG += emitted.co2G
      this.distanceTotalM += driven
      moved.push({
        ...car,
        distance: next.x,
        velocity: next.v,
        co2G: car.co2G + emitted.co2G,
        traveledM: car.traveledM + driven,
        stoppedS: car.stoppedS + (emitted.standing ? dt : 0),
      })
    }

    const stillIn: CarState[] = []
    for (const car of moved) {
      if (car.distance < (this.lengths.get(car.routeId) ?? 0) - 1e-9) stillIn.push(car)
      else {
        this.arrivedTotal += 1
        const arrival: Arrival = {
          carId: car.id,
          routeId: car.routeId,
          atMs: this.timeMs + dtMs,
          travelS: (this.timeMs + dtMs - (car.bornAtMs ?? 0)) / 1000,
          co2G: car.co2G,
          distanciaM: car.traveledM,
          paradoS: car.stoppedS,
        }
        this.travelSumS += arrival.travelS
        this.arrivals.push(arrival)
        while (this.arrivals.length && this.arrivals[0].atMs <= arrival.atMs - 60_000) this.arrivals.shift()
        for (const l of this.arrivalListeners) l(arrival)
        this.redDecision.delete(car.id)
      }
    }
    this.cars = stillIn

    const spawned = this.generator.tick(dtMs, this.network.routes)
    this.spawnedTotal += spawned.length
    for (const c of spawned) this.routeTotals[c.routeId] = (this.routeTotals[c.routeId] ?? 0) + 1
    this.waiting.push(...spawned.map((c) => ({ ...c, bornAtMs: this.timeMs })))
    this.applyDiversion()
    this.admitWaiting()
    this.timeMs += dtMs
    const expired = this.blockages.filter((b) => b.endsAtMs <= this.timeMs)
    this.blockages = this.blockages.filter((b) => b.endsAtMs > this.timeMs)
    for (const b of expired) this.emitBlockage(b, false)
    this.signals.advance(this.timeMs, (id) => this.queueAt(id))

    const readings = this.sensor.observe(dtMs, this.timeMs, this.cameras, this.coverage, this.observations())
    for (const r of readings) for (const l of this.readingListeners) l(r)
  }

  /** The first waiting car enters at the origin when there are 7 m free, as fast as is safe. */
  /** Decides, once per car, which waiting cars bound for `from` go to `to` (AD-014). */
  private applyDiversion(): void {
    const d = this.diversion
    if (!d) return
    for (const car of this.waiting) {
      if (car.routeId !== d.from || this.diversionDecided.has(car.id)) continue
      this.diversionDecided.add(car.id)
      this.diversionBudget += d.fraction
      if (this.diversionBudget >= 1 - 1e-9) {
        this.diversionBudget -= 1
        car.routeId = d.to
        this.diversionDecided.delete(car.id)
        this.divertedTotal += 1
        this.routeTotals[d.from] -= 1
        this.routeTotals[d.to] = (this.routeTotals[d.to] ?? 0) + 1
      }
    }
  }

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
      // enter at the highest speed whose IDM response to the car ahead is no harder than -b and
      // that the room ahead can absorb within one headway
      let v = car.speed
      if (Number.isFinite(last)) {
        const gap = last - IDM.length
        v = Math.min(v, Math.max(0, gap - IDM.s0) / IDM.T)
        while (v > 0 && idmAcceleration(v, car.speed, gap, v - lastV) < -IDM.b) v = Math.max(0, v - 0.25)
      }
      this.cars.push({ ...car, velocity: v, co2G: 0, traveledM: 0, stoppedS: 0 })
    }
    this.waiting = remaining
  }


  private observations(): CarSample[] {
    const routes = new Map(this.network.routes.map((r) => [r.id, r]))
    return this.cars.map((car) => {
      const p = positionOnRoute(routes.get(car.routeId)!, car.distance)
      const segment = segmentAt(this.segments, car.routeId, car.distance)
      return { x: p.x, y: p.y, speedKmh: car.velocity * 3.6, segmentId: segment?.id ?? '' }
    })
  }

  getState(): SimulationState {
    return {
      network: this.network,
      cars: this.cars,
      spawnedTotal: this.spawnedTotal,
      ratePerMinute: this.generator.getRate(),
      waitingAtOrigin: this.waiting.length,
      waitingByRoute: Object.fromEntries(
        this.network.routes.map((r) => [r.id, this.waiting.filter((c) => c.routeId === r.id).length]),
      ),
      arrivedTotal: this.arrivedTotal,
      timeMs: this.timeMs,
      lights: this.lights(this.timeMs),
      cameras: this.cameras,
      segments: this.segments,
      noisePct: this.sensor.getNoise(),
      blockages: this.blockages,
      diversion: this.diversion,
      divertedTotal: this.divertedTotal,
      routeTotals: { ...this.routeTotals },
      adaptiveSignals: this.signals.isAdaptive(),
      co2TotalG: this.co2TotalG,
      distanceTotalM: this.distanceTotalM,
    }
  }
}
