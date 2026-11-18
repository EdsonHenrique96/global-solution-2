import { mulberry32 } from '../sim/random'
import type { Drone } from '../sim/types'
import { applyNoise } from './noise'

export const WINDOW_MS = 10_000
export const MAX_NOISE_PCT = 30
export const DEFAULT_NOISE_PCT = 10
export const DEFAULT_SEED = 42

/** One drone's reading for a closed window - the telemetry payload (door 1). */
export interface Reading {
  droneId: string
  /** Simulated time when the window closed, in ms. */
  ts: number
  janelaS: number
  contagem: number
  velocidadeMediaKmh: number | null
  ruidoPct: number
}

/** A car as a drone sees it: where it is and how fast it goes. */
export interface Observation {
  x: number
  y: number
  speedKmh: number
}

interface SensorOptions {
  windowMs?: number
  noisePct?: number
  rng?: () => number
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
  private elapsed = 0
  private sums = new Map<string, { total: number; samples: number }>()

  constructor({ windowMs = WINDOW_MS, noisePct = DEFAULT_NOISE_PCT, rng = mulberry32(DEFAULT_SEED) }: SensorOptions = {}) {
    this.windowMs = windowMs
    this.noisePct = clampNoise(noisePct)
    this.rng = rng
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
      const acc = this.sums.get(drone.id) ?? { total: 0, samples: 0 }
      for (const o of seen) {
        acc.total += o.speedKmh
        acc.samples += 1
      }
      this.sums.set(drone.id, acc)
    }

    this.elapsed += dtMs
    if (this.elapsed < this.windowMs) return []
    this.elapsed -= this.windowMs

    const readings = drones.map((drone): Reading => {
      const acc = this.sums.get(drone.id) ?? { total: 0, samples: 0 }
      const count = inRange.get(drone.id)?.length ?? 0
      const mean = acc.samples > 0 ? acc.total / acc.samples : null
      return {
        droneId: drone.id,
        ts: nowMs,
        janelaS: this.windowMs / 1000,
        contagem: Math.max(0, Math.round(applyNoise(count, this.noisePct, this.rng))),
        velocidadeMediaKmh: mean === null ? null : Math.max(0, round1(applyNoise(mean, this.noisePct, this.rng))),
        ruidoPct: this.noisePct,
      }
    })
    this.sums = new Map()
    return readings
  }
}
