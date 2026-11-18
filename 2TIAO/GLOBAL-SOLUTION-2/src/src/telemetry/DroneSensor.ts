import { mulberry32 } from '../sim/random'
import type { Drone, Point, Route } from '../sim/types'
import { applyNoise } from './noise'

export const WINDOW_MS = 10_000
export const MAX_NOISE_PCT = 30
export const DEFAULT_NOISE_PCT = 10
export const DEFAULT_SEED = 42

/** What one drone saw of one route in a window (modelo-capacidade door). */
export interface ViaReading {
  via: string
  contagem: number
  velocidadeMediaKmh: number | null
  /** Length of the route inside the drone's circle, metres. */
  comprimentoM: number
}

/** One drone's reading for a closed window - the telemetry payload (door 1). */
export interface Reading {
  droneId: string
  /** Simulated time when the window closed, in ms. */
  ts: number
  janelaS: number
  contagem: number
  velocidadeMediaKmh: number | null
  ruidoPct: number
  porVia: ViaReading[]
}

/** A car as a drone sees it: where it is and how fast it goes. */
export interface Observation {
  x: number
  y: number
  speedKmh: number
  /** Route the car is on. */
  via?: string
}

interface SensorOptions {
  windowMs?: number
  noisePct?: number
  rng?: () => number
  /** Routes to break readings down by; without them `porVia` is empty. */
  routes?: readonly Route[]
}

/** Length of a polyline inside a circle (exact, segment by segment). */
export function lengthInsideCircle(points: readonly Point[], center: Point, radius: number): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) continue
    const fx = a.x - center.x
    const fy = a.y - center.y
    // |a + t(b - a) - c|^2 <= r^2  ->  len2 t^2 + 2 (f.d) t + (|f|^2 - r^2) <= 0
    const bq = 2 * (fx * dx + fy * dy)
    const cq = fx * fx + fy * fy - radius * radius
    const disc = bq * bq - 4 * len2 * cq
    if (disc <= 0) continue
    const sq = Math.sqrt(disc)
    const t1 = Math.max(0, (-bq - sq) / (2 * len2))
    const t2 = Math.min(1, (-bq + sq) / (2 * len2))
    if (t2 > t1) total += (t2 - t1) * Math.sqrt(len2)
  }
  return total
}

export function clampNoise(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.min(MAX_NOISE_PCT, Math.max(0, Math.round(pct)))
}

const round1 = (v: number) => Math.round(v * 10) / 10

/**
 * Samples every tick the cars inside each drone's radius; when a window closes it reports, per
 * drone, the cars in range at the close and the mean of the sampled speeds, with noise.
 */
export class DroneSensor {
  private readonly windowMs: number
  private readonly rng: () => number
  private noisePct: number
  private readonly routes: readonly Route[]
  private elapsed = 0
  private sums = new Map<string, { total: number; samples: number }>()

  constructor({
    windowMs = WINDOW_MS,
    noisePct = DEFAULT_NOISE_PCT,
    rng = mulberry32(DEFAULT_SEED),
    routes = [],
  }: SensorOptions = {}) {
    this.windowMs = windowMs
    this.noisePct = clampNoise(noisePct)
    this.rng = rng
    this.routes = [...routes].sort((a, b) => a.id.localeCompare(b.id))
  }

  private accumulate(key: string, seen: readonly Observation[]) {
    const acc = this.sums.get(key) ?? { total: 0, samples: 0 }
    for (const o of seen) {
      acc.total += o.speedKmh
      acc.samples += 1
    }
    this.sums.set(key, acc)
  }

  private noisyCount(count: number): number {
    return Math.max(0, Math.round(applyNoise(count, this.noisePct, this.rng)))
  }

  private noisyMean(key: string): number | null {
    const acc = this.sums.get(key)
    if (!acc || acc.samples === 0) return null
    return Math.max(0, round1(applyNoise(acc.total / acc.samples, this.noisePct, this.rng)))
  }

  getNoise(): number {
    return this.noisePct
  }

  setNoise(pct: number): void {
    this.noisePct = clampNoise(pct)
  }

  observe(dtMs: number, nowMs: number, drones: readonly Drone[], observations: readonly Observation[]): Reading[] {
    const inRange = new Map<string, Observation[]>()
    for (const drone of drones) {
      const seen = observations.filter(
        (o) => Math.hypot(o.x - drone.position.x, o.y - drone.position.y) <= drone.radius,
      )
      inRange.set(drone.id, seen)
      this.accumulate(drone.id, seen)
      for (const route of this.routes) {
        this.accumulate(`${drone.id}|${route.id}`, seen.filter((o) => o.via === route.id))
      }
    }

    this.elapsed += dtMs
    if (this.elapsed < this.windowMs) return []
    this.elapsed -= this.windowMs

    const readings = drones.map((drone): Reading => {
      const seen = inRange.get(drone.id) ?? []
      const contagem = this.noisyCount(seen.length)
      const velocidadeMediaKmh = this.noisyMean(drone.id)
      const porVia: ViaReading[] = []
      for (const route of this.routes) {
        const length = lengthInsideCircle(route.points, drone.position, drone.radius)
        if (length <= 0) continue
        const key = `${drone.id}|${route.id}`
        porVia.push({
          via: route.id,
          contagem: this.noisyCount(seen.filter((o) => o.via === route.id).length),
          velocidadeMediaKmh: this.noisyMean(key),
          comprimentoM: round1(length),
        })
      }
      return {
        droneId: drone.id,
        ts: nowMs,
        janelaS: this.windowMs / 1000,
        contagem,
        velocidadeMediaKmh,
        ruidoPct: this.noisePct,
        porVia,
      }
    })
    this.sums = new Map()
    return readings
  }
}
