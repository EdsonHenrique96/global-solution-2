import { DEFAULT_APP_SHARE, drawApp } from '../apps/apps'
import { defaultUnits, unitId, type FixedCamera } from '../sensors/camera'
import { CoverageIndex } from '../sensors/coverage'
import { SensorReader, type CarSample, type Reading } from '../sensors/reader'
import { buildSegments, pointOnSegment, type Segment } from '../sensors/segments'
import { stepEmission } from '../experiments/emission'
import { CarGenerator, DEFAULT_CAR_SPEED } from './carGenerator'
import { borderIds, buildCityNetwork } from './cityNetwork'
import { shortestPath } from './graph'
import { IDM, idmAcceleration, LOOKAHEAD_M, MAX_DECEL, MAX_STOP_DECEL, step } from './idm'
import { mulberry32 } from './random'
import { phaseFor, SignalController, type LightState } from './trafficLight'
import type { AppName, Axis, Car, Point, RoadNetwork } from './types'

export const TICK_MS = 100
export const DEFAULT_RATE_PER_MINUTE = 30
/** Stop line, metres before the corner. */
export const STOP_LINE_M = 12
/** Cars this close to a corner, free to cross it, take turns entering the same next segment. */
export const CORNER_ZONE_M = 50

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

/** A stopped obstacle on a segment (accident, AD-016). */
export interface Blockage {
  id: number
  segmentId: string
  distance: number
  endsAtMs: number
}

export interface Arrival {
  carId: number
  atMs: number
  travelS: number
  co2G: number
  distanciaM: number
  paradoS: number
}

/** A car entering a segment (the map apps see their own drivers' entries). */
export interface SegmentEntry {
  carId: number
  segmentId: string
  app: AppName | null
  atMs: number
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
  /** Generated cars still waiting for room to enter at their corner. */
  waitingToEnter: number
  arrivedTotal: number
  timeMs: number
  lights: readonly LightState[]
  cameras: readonly FixedCamera[]
  segments: readonly Segment[]
  noisePct: number
  blockages: readonly Blockage[]
  adaptiveSignals: boolean
  /** Cars that took a new path after a notification. */
  reroutedTotal: number
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
  /** Camera+radar units; [] for a map without sensors. */
  cameras?: readonly FixedCamera[]
  noisePct?: number
  seed?: number
  /** 'deterministic' (default) spaces cars evenly; 'poisson' draws exponential gaps from the seed. */
  arrivals?: 'deterministic' | 'poisson'
  /** Share of drivers with a map app open. */
  appShare?: number
}

export const CAMERA_LIMITS = { fovMin: 10, fovMax: 170, rangeMin: 20, rangeMax: 500 } as const

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

/**
 * The city: cars drive along their path of directed segments by IDM, stop on red at each corner's
 * stop line, enter the next segment only when there is room, and leave at the end of their path.
 */
export class SimulationEngine {
  private readonly network: RoadNetwork
  private readonly generator: CarGenerator
  private readonly segments: Segment[]
  private readonly segById: Map<string, Segment>
  private readonly lightMode: 'fixed' | 'always-green'
  private readonly sensor: SensorReader
  readonly coverage: CoverageIndex
  private readonly speed: number
  private readonly borders: string[]
  private readonly tripRng: () => number
  private readonly appRng: () => number
  private readonly appShare: number
  private readonly paths = new Map<string, string[]>()
  private readonly readingListeners = new Set<(r: Reading) => void>()
  private readonly entryListeners = new Set<(e: SegmentEntry) => void>()
  private cars: CarState[] = []
  private waiting: CarState[] = []
  private cameras: FixedCamera[]
  private nextCamera = 1
  private nextCarId = 1
  private spawnedTotal = 0
  private arrivedTotal = 0
  private reroutedTotal = 0
  /** Each car's stop-or-go decision for the red light ahead of it, per segment. */
  private readonly redDecision = new Map<number, { segmentId: string; go: boolean }>()
  /** Corner turns: when each car free to cross became a contender for its next segment. */
  private readonly cornerTickets = new Map<number, { target: string; atMs: number; r: number }>()
  private timeMs = 0
  private readonly signals: SignalController
  private blockages: Blockage[] = []
  private blockageId = 1
  private readonly arrivalListeners = new Set<(a: Arrival) => void>()
  private readonly blockageListeners = new Set<(e: { blockage: Blockage; ativo: boolean; ts: number }) => void>()
  private readonly arrivals: Arrival[] = []
  private travelSumS = 0
  private co2TotalG = 0
  private distanceTotalM = 0

  constructor(options: SimulationOptions = {}) {
    this.network = buildCityNetwork()
    this.speed = options.speed ?? DEFAULT_CAR_SPEED
    const seed = options.seed ?? 42
    this.generator = new CarGenerator(options.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE, {
      arrivals: options.arrivals ?? 'deterministic',
      rng: mulberry32(seed * 7919 + 1),
    })
    this.tripRng = mulberry32(seed * 104_729 + 3)
    this.appRng = mulberry32(seed * 15_485_863 + 5)
    this.appShare = options.appShare ?? DEFAULT_APP_SHARE
    this.lightMode = options.trafficLights ?? 'fixed'
    this.signals = new SignalController(this.network.intersections.map((i) => i.id))
    this.segments = buildSegments(this.network)
    this.segById = new Map(this.segments.map((s) => [s.id, s]))
    this.borders = borderIds(this.network)
    const positions = new Map(this.network.intersections.map((i) => [i.id, i.position]))
    this.cameras = (options.cameras ?? defaultUnits(positions)).map((c) => ({ ...c, position: { ...c.position } }))
    this.coverage = new CoverageIndex(this.segments)
    this.coverage.setCameras(this.cameras)
    this.nextCamera = 1 + Math.max(0, ...this.cameras.map((c) => Number(c.id.replace(/\D/g, '')) || 0))
    this.sensor = new SensorReader({ noisePct: options.noisePct, rng: mulberry32(seed) })
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

  getAppShare(): number {
    return this.appShare
  }

  segment(id: string): Segment | undefined {
    return this.segById.get(id)
  }

  /** Shortest path in metres between two corners (cached). */
  pathBetween(from: string, to: string): string[] | null {
    const key = `${from}|${to}`
    const cached = this.paths.get(key)
    if (cached) return cached
    const path = shortestPath(this.segments, from, to)
    if (path) this.paths.set(key, path)
    return path
  }

  /** Moves a unit, clamped to the map area; the coverage index follows. */
  moveCamera(id: string, to: Point): void {
    const { minX, minY, maxX, maxY } = this.network.bounds
    this.updateCamera(id, { position: { x: Math.min(maxX, Math.max(minX, to.x)), y: Math.min(maxY, Math.max(minY, to.y)) } })
  }

  /**
   * Changes a unit's position, heading, FOV or range, clamped to their limits (heading wraps to
   * 0-359, FOV 10-170, range 20-500, anything not a number keeps the old value). Camera and radar
   * move together; the coverage index is rebuilt only when something changed.
   */
  updateCamera(id: string, change: Partial<Omit<FixedCamera, 'id'>>): void {
    const i = this.cameras.findIndex((c) => c.id === id)
    if (i === -1) return
    this.cameras[i] = clampCamera({ ...this.cameras[i], ...change, position: { ...(change.position ?? this.cameras[i].position) } }, this.cameras[i])
    this.coverage.updateCamera(this.cameras[i])
  }

  /** Adds the next unit (U13, U14, ... - ids are never reused) at the map centre. */
  addCamera(): FixedCamera {
    const { minX, minY, maxX, maxY } = this.network.bounds
    const camera: FixedCamera = { id: unitId(this.nextCamera++), position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, heading: 90, fov: 40, range: 130 }
    this.cameras.push(camera)
    this.coverage.setCameras(this.cameras)
    return camera
  }

  removeCamera(id: string): void {
    this.cameras = this.cameras.filter((c) => c.id !== id)
    this.coverage.setCameras(this.cameras)
  }

  /** Places a car on the road (scenario setup; the generator makes trips between border corners). */
  addCar({
    path,
    seg = 0,
    distance = 0,
    velocity = this.speed,
    app = null,
  }: {
    path: string[]
    seg?: number
    distance?: number
    velocity?: number
    app?: AppName | null
  }): CarState {
    const first = this.segById.get(path[0])!
    const last = this.segById.get(path[path.length - 1])!
    const car: CarState = {
      id: this.nextCarId++,
      path: [...path],
      seg,
      distance,
      speed: this.speed,
      velocity,
      app,
      entrada: first.from,
      saida: last.to,
      bornAtMs: this.timeMs,
      co2G: 0,
      traveledM: 0,
      stoppedS: 0,
    }
    this.cars.push(car)
    return car
  }

  onReading(listener: (r: Reading) => void): () => void {
    this.readingListeners.add(listener)
    return () => this.readingListeners.delete(listener)
  }

  onSegmentEntry(listener: (e: SegmentEntry) => void): () => void {
    this.entryListeners.add(listener)
    return () => this.entryListeners.delete(listener)
  }

  private emitEntry(car: CarState): void {
    const e: SegmentEntry = { carId: car.id, segmentId: car.path[car.seg], app: car.app, atMs: this.timeMs }
    for (const l of this.entryListeners) l(e)
  }

  private lights(timeMs: number): LightState[] {
    if (this.lightMode === 'always-green') {
      return this.network.intersections.map((i) => ({ intersectionId: i.id, h: 'verde', v: 'verde', remainingS: Infinity }))
    }
    return this.signals.lights(timeMs)
  }

  /** The next green of one phase of a light, in seconds (adaptive control only). */
  setNextGreen(intersectionId: string, axis: Axis, seconds: number): boolean {
    return this.signals.setNextGreen(intersectionId, axis, seconds)
  }

  setAdaptiveSignals(on: boolean): void {
    this.signals.setAdaptive(on, this.timeMs)
  }

  /** Cars under 5 km/h in the 150 m before a corner's stop line, on approaches along `axis` (both when omitted). */
  queueAt(intersectionId: string, axis?: Axis): number {
    let count = 0
    for (const car of this.cars) {
      const s = this.segById.get(car.path[car.seg])!
      if (s.to !== intersectionId || (axis && s.axis !== axis)) continue
      const line = s.length - STOP_LINE_M
      if (car.distance <= line + 1e-9 && car.distance >= line - QUEUE_REACH_M && car.velocity < QUEUE_SPEED_MS) count += 1
    }
    return count
  }

  /** Slow cars on the road plus cars waiting to enter. */
  queueTotal(): number {
    return this.cars.filter((c) => c.velocity < QUEUE_SPEED_MS).length + this.waiting.length
  }

  /** Blocks a segment at a point for `durationMs` (2 min by default, AD-016). */
  addBlockage(segmentId: string, distance: number, durationMs = BLOCKAGE_MS): Blockage {
    const b: Blockage = { id: this.blockageId++, segmentId, distance, endsAtMs: this.timeMs + durationMs }
    this.blockages.push(b)
    this.emitBlockage(b, true)
    return b
  }

  removeBlockage(id: number): void {
    const gone = this.blockages.filter((b) => b.id === id)
    this.blockages = this.blockages.filter((b) => b.id !== id)
    for (const b of gone) this.emitBlockage(b, false)
  }

  /** Accident started (ativo) or ended - by hand or after its duration. */
  onBlockage(listener: (e: { blockage: Blockage; ativo: boolean; ts: number }) => void): () => void {
    this.blockageListeners.add(listener)
    return () => this.blockageListeners.delete(listener)
  }

  private emitBlockage(blockage: Blockage, ativo: boolean): void {
    for (const l of this.blockageListeners) l({ blockage, ativo, ts: this.timeMs })
  }

  /**
   * Replaces what a car drives after its current segment (after its first one while it still
   * waits to enter). `rest` must start at the corner the current segment ends at. Returns whether
   * it was taken.
   */
  reroute(carId: number, rest: readonly string[]): boolean {
    const car = this.cars.find((c) => c.id === carId) ?? this.waiting.find((c) => c.id === carId)
    if (!car || rest.length === 0) return false
    let at = this.segById.get(car.path[car.seg])!.to
    for (const id of rest) {
      const s = this.segById.get(id)
      if (!s || s.from !== at) return false
      at = s.to
    }
    car.path = [...car.path.slice(0, car.seg + 1), ...rest]
    car.saida = at
    this.redDecision.delete(car.id)
    this.reroutedTotal += 1
    return true
  }

  /** The cars still waiting to enter (the map apps already know their drivers). */
  waitingCars(): readonly CarState[] {
    return this.waiting
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

  /**
   * One step. Everything a car reacts to is read from the start of the tick: the car ahead on its
   * segment or the first one on its next segment, a blockage ahead, and the stop line of a red light
   * it can still stop for. A car reaching the end of its segment enters the next one only if there
   * is room there (it waits at the corner otherwise) or leaves at the end of its path. Then waiting
   * cars enter, new trips are drawn and the sensors sample.
   */
  tick(dtMs: number): void {
    const dt = dtMs / 1000
    const lightBy = new Map(this.lights(this.timeMs).map((l) => [l.intersectionId, l]))

    const bySeg = new Map<string, CarState[]>()
    for (const car of this.cars) {
      const id = car.path[car.seg]
      const list = bySeg.get(id)
      if (list) list.push(car)
      else bySeg.set(id, [car])
    }
    // order along each segment; equal positions by id so every car has one well-defined leader
    const rank = new Map<number, number>()
    for (const list of bySeg.values()) {
      list.sort((a, b) => a.distance - b.distance || b.id - a.id)
      list.forEach((c, i) => rank.set(c.id, i))
    }

    const yielding = this.cornerTurns(bySeg, rank, lightBy)

    const moved: CarState[] = []
    for (const car of this.cars) {
      const seg = this.segById.get(car.path[car.seg])!
      const L = seg.length
      const nextId = car.seg < car.path.length - 1 ? car.path[car.seg + 1] : null
      let gap = Infinity
      let leadV = 0
      const consider = (g: number, v: number) => {
        if (g < gap && g <= LOOKAHEAD_M) {
          gap = g
          leadV = v
        }
      }
      const ahead = bySeg.get(seg.id)![rank.get(car.id)! + 1]
      if (ahead) consider(ahead.distance - car.distance - IDM.length, ahead.velocity)
      else if (nextId) {
        const first = bySeg.get(nextId)?.[0]
        if (first) consider(L - car.distance + first.distance - IDM.length, first.velocity)
      }

      // accidents: a standing obstacle ahead on this segment or at the start of the next
      let blockRoom = Infinity
      for (const b of this.blockages) {
        if (b.segmentId === seg.id && b.distance > car.distance) {
          const g = b.distance - car.distance - IDM.length
          consider(g, 0)
          blockRoom = Math.min(blockRoom, g - IDM.s0)
        } else if (nextId && b.segmentId === nextId) {
          consider(L - car.distance + b.distance - IDM.length, 0)
        }
      }

      // another car has the turn into the same next segment: it waits one car length before the
      // corner, as behind a standing car there, so the one that goes appears ahead of it with room
      let yieldRoom = Infinity
      if (yielding.has(car.id)) {
        const g = L - car.distance - IDM.length
        consider(g, 0)
        yieldRoom = g - IDM.s0
      }

      // red light at the corner ahead (not on the last segment: the car leaves the city there):
      // decided once per light - stop if it can with at most 4.5 m/s², otherwise go through; a car
      // that stops brakes at the constant deceleration that ends exactly at the line
      let lineRoom = Infinity
      let accLine = Infinity
      const light = nextId ? lightBy.get(seg.to) : undefined
      const line = L - STOP_LINE_M
      if (light && car.distance <= line + 1e-9 && phaseFor(light, seg.axis) === 'vermelho') {
        const toLine = line - car.distance
        const needed = (car.velocity * car.velocity) / (2 * Math.max(toLine, 0.01))
        let decision = this.redDecision.get(car.id)
        if (decision?.segmentId !== seg.id) {
          decision = { segmentId: seg.id, go: needed > MAX_STOP_DECEL }
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
      const acc = Math.max(-MAX_DECEL, Math.min(accLeader, accLine))
      const room = Math.min(Number.isFinite(gap) ? gap - IDM.s0 : Infinity, lineRoom, blockRoom, yieldRoom)
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

    // corners: the car furthest past the end of its segment goes first; a car finds room on its
    // next segment or waits at the end of its own
    const tail = new Map<string, number>()
    for (const c of moved) {
      const L = this.segById.get(c.path[c.seg])!.length
      if (c.distance < L - 1e-9) tail.set(c.path[c.seg], Math.min(tail.get(c.path[c.seg]) ?? Infinity, c.distance))
    }
    const stillIn: CarState[] = []
    const crossing = moved
      .filter((c) => c.distance >= this.segById.get(c.path[c.seg])!.length - 1e-9)
      .sort((a, b) => b.distance - this.segById.get(b.path[b.seg])!.length - (a.distance - this.segById.get(a.path[a.seg])!.length))
    for (const c of moved) if (!crossing.includes(c)) stillIn.push(c)
    for (const car of crossing) {
      const L = this.segById.get(car.path[car.seg])!.length
      if (car.seg === car.path.length - 1) {
        this.arrive(car, dtMs)
        continue
      }
      const nextId = car.path[car.seg + 1]
      const over = car.distance - L
      const room = (tail.get(nextId) ?? Infinity) - over
      if (room >= IDM.length + IDM.s0) {
        const entered = { ...car, seg: car.seg + 1, distance: over }
        tail.set(nextId, Math.min(tail.get(nextId) ?? Infinity, over))
        stillIn.push(entered)
        this.redDecision.delete(car.id)
        this.emitEntry(entered)
      } else {
        stillIn.push({ ...car, distance: L, velocity: 0 })
      }
    }
    this.cars = stillIn

    this.spawn(this.generator.tick(dtMs))
    this.admitWaiting()
    this.timeMs += dtMs
    const expired = this.blockages.filter((b) => b.endsAtMs <= this.timeMs)
    this.blockages = this.blockages.filter((b) => b.endsAtMs > this.timeMs)
    for (const b of expired) this.emitBlockage(b, false)
    this.signals.advance(this.timeMs, (id, axis) => this.queueAt(id, axis))

    const readings = this.sensor.observe(dtMs, this.timeMs, this.cameras, this.coverage, this.observations())
    for (const r of readings) for (const l of this.readingListeners) l(r)
  }

  /** Whether a car is held by the red light ahead of it (before its line, decided to stop). */
  private heldByRed(car: CarState, lightBy: ReadonlyMap<string, LightState>): boolean {
    const seg = this.segById.get(car.path[car.seg])!
    const light = car.seg < car.path.length - 1 ? lightBy.get(seg.to) : undefined
    return (
      light !== undefined &&
      phaseFor(light, seg.axis) === 'vermelho' &&
      car.distance <= seg.length - STOP_LINE_M + 1e-9 &&
      !this.redDecision.get(car.id)?.go
    )
  }

  /**
   * Corner turns: the front car of each segment, within CORNER_ZONE_M of its corner and free to
   * cross it, contends for its next segment. When two segments' front cars head into the same one,
   * a car that can no longer stop comfortably before its waiting point goes first (nearest first),
   * then the first to become a contender; the others yield (cars from opposite approaches turning
   * into the same street on one green). Returns the cars that yield.
   */
  private cornerTurns(
    bySeg: ReadonlyMap<string, CarState[]>,
    rank: ReadonlyMap<number, number>,
    lightBy: ReadonlyMap<string, LightState>,
  ): Set<number> {
    const contenders = new Map<string, { id: number; atMs: number; r: number; committed: boolean; now: number }[]>()
    const present = new Set<number>()
    for (const car of this.cars) {
      const segId = car.path[car.seg]
      const front = rank.get(car.id) === bySeg.get(segId)!.length - 1
      const nextId = car.seg < car.path.length - 1 ? car.path[car.seg + 1] : null
      const r = this.segById.get(segId)!.length - car.distance
      if (!front || !nextId || r > CORNER_ZONE_M || this.heldByRed(car, lightBy)) continue
      let t = this.cornerTickets.get(car.id)
      if (!t || t.target !== nextId) {
        t = { target: nextId, atMs: this.timeMs, r }
        this.cornerTickets.set(car.id, t)
      }
      present.add(car.id)
      const list = contenders.get(nextId)
      // stopping one car length before the corner would take more than 4.5 m/s²
      const committed = (car.velocity * car.velocity) / (2 * Math.max(r - IDM.length - IDM.s0, 0.01)) > MAX_STOP_DECEL
      const entry = { id: car.id, atMs: t.atMs, r: t.r, committed, now: r }
      if (list) list.push(entry)
      else contenders.set(nextId, [entry])
    }
    for (const id of [...this.cornerTickets.keys()]) if (!present.has(id)) this.cornerTickets.delete(id)
    const yielding = new Set<number>()
    for (const list of contenders.values()) {
      if (list.length < 2) continue
      list.sort((a, b) => Number(b.committed) - Number(a.committed) || (a.committed ? a.now - b.now : 0) || a.atMs - b.atMs || a.r - b.r || a.id - b.id)
      for (const c of list.slice(1)) yielding.add(c.id)
    }
    return yielding
  }

  private arrive(car: CarState, dtMs: number): void {
    this.arrivedTotal += 1
    const atMs = this.timeMs + dtMs
    const arrival: Arrival = {
      carId: car.id,
      atMs,
      travelS: (atMs - (car.bornAtMs ?? 0)) / 1000,
      co2G: car.co2G,
      distanciaM: car.traveledM,
      paradoS: car.stoppedS,
    }
    this.travelSumS += arrival.travelS
    this.arrivals.push(arrival)
    while (this.arrivals.length && this.arrivals[0].atMs <= atMs - 60_000) this.arrivals.shift()
    for (const l of this.arrivalListeners) l(arrival)
    this.redDecision.delete(car.id)
  }

  /** Draws each new trip: two different border corners, the shortest path, and the driver's app. */
  private spawn(due: number): void {
    for (; due > 0; due--) {
      const n = this.borders.length
      const entrada = this.borders[Math.floor(this.tripRng() * n)]
      let saida = this.borders[Math.floor(this.tripRng() * (n - 1))]
      if (saida === entrada) saida = this.borders[n - 1]
      const path = this.pathBetween(entrada, saida)!
      this.spawnedTotal += 1
      this.waiting.push({
        id: this.nextCarId++,
        path: [...path],
        seg: 0,
        distance: 0,
        speed: this.speed,
        velocity: 0,
        app: drawApp(this.appRng, this.appShare),
        entrada,
        saida,
        bornAtMs: this.timeMs,
        co2G: 0,
        traveledM: 0,
        stoppedS: 0,
      })
    }
  }

  /** FIFO per first segment: one car per segment per tick, when the last car on it is 7 m in. */
  private admitWaiting(): void {
    if (this.waiting.length === 0) return
    const lightBy = new Map(this.lights(this.timeMs).map((l) => [l.intersectionId, l]))
    const done = new Set<string>()
    const remaining: CarState[] = []
    for (const car of this.waiting) {
      const segId = car.path[0]
      if (done.has(segId)) {
        remaining.push(car)
        continue
      }
      done.add(segId)
      let last = Infinity
      let lastV = 0
      for (const other of this.cars) {
        if (other.path[other.seg] === segId && other.distance < last) {
          last = other.distance
          lastV = other.velocity
        }
      }
      const blocked = this.blockages.some((b) => b.segmentId === segId && b.distance < IDM.length + IDM.s0)
      // a car about to turn into this segment goes first
      const incoming = this.cars.some((o) => {
        if (o.path[o.seg + 1] !== segId) return false
        const r = this.segById.get(o.path[o.seg])!.length - o.distance
        return r <= CORNER_ZONE_M && !this.heldByRed(o, lightBy)
      })
      if (last < IDM.length + IDM.s0 || blocked || incoming) {
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
      const entered = { ...car, velocity: v, bornAtMs: car.bornAtMs }
      this.cars.push(entered)
      this.emitEntry(entered)
    }
    this.waiting = remaining
  }

  private observations(): CarSample[] {
    return this.cars.map((car) => {
      const s = this.segById.get(car.path[car.seg])!
      const p = pointOnSegment(s, car.distance)
      return { x: p.x, y: p.y, speedKmh: car.velocity * 3.6, segmentId: s.id }
    })
  }

  getState(): SimulationState {
    return {
      network: this.network,
      cars: this.cars,
      spawnedTotal: this.spawnedTotal,
      ratePerMinute: this.generator.getRate(),
      waitingToEnter: this.waiting.length,
      arrivedTotal: this.arrivedTotal,
      timeMs: this.timeMs,
      lights: this.lights(this.timeMs),
      cameras: this.cameras,
      segments: this.segments,
      noisePct: this.sensor.getNoise(),
      blockages: this.blockages,
      adaptiveSignals: this.signals.isAdaptive(),
      reroutedTotal: this.reroutedTotal,
      co2TotalG: this.co2TotalG,
      distanceTotalM: this.distanceTotalM,
    }
  }
}
