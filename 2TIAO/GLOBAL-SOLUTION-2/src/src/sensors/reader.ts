import { mulberry32 } from '../sim/random'
import { applyNoise } from '../telemetry/noise'
import { insidePolygon, type FixedCamera } from './camera'
import { COVERAGE_MIN, type CoverageIndex } from './coverage'

export const WINDOW_MS = 10_000
export const MAX_NOISE_PCT = 30
export const DEFAULT_NOISE_PCT = 10
export const DEFAULT_SEED = 42

/** What a sensor saw of one segment in a window (trechos-cameras door 1). */
export interface SegmentReading {
  trecho: string
  contagem: number
  velocidadeMediaKmh: number | null
  /** Segment length inside the sensor's polygon, metres. */
  comprimentoCobertoM: number
  cobertura: number
}

/** One sensor's reading for a closed window - the telemetry payload. */
export interface Reading {
  sensorId: string
  tipo: 'fixo'
  /** Simulated time when the window closed, ms. */
  ts: number
  janelaS: number
  contagem: number
  velocidadeMediaKmh: number | null
  ruidoPct: number
  porTrecho: SegmentReading[]
}

/** A car as a sensor sees it. */
export interface CarSample {
  x: number
  y: number
  speedKmh: number
  segmentId: string
}

export function clampNoise(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.min(MAX_NOISE_PCT, Math.max(0, Math.round(pct)))
}

const round1 = (v: number) => Math.round(v * 10) / 10
const round3 = (v: number) => Math.round(v * 1000) / 1000

interface Options {
  windowMs?: number
  noisePct?: number
  rng?: () => number
}

/**
 * Samples, every tick, the cars inside each camera's polygon - and only those (AC 6). When a
 * window closes it reports per camera the cars inside at the close and the mean sampled speed,
 * and the same per segment the camera covers at least COVERAGE_MIN of.
 */
export class SensorReader {
  private readonly windowMs: number
  private readonly rng: () => number
  private noisePct: number
  private elapsed = 0
  private sums = new Map<string, { total: number; samples: number }>()

  constructor({ windowMs = WINDOW_MS, noisePct = DEFAULT_NOISE_PCT, rng = mulberry32(DEFAULT_SEED) }: Options = {}) {
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

  private add(key: string, seen: readonly CarSample[]) {
    const acc = this.sums.get(key) ?? { total: 0, samples: 0 }
    for (const s of seen) {
      acc.total += s.speedKmh
      acc.samples += 1
    }
    this.sums.set(key, acc)
  }

  private noisyCount(n: number): number {
    return Math.max(0, Math.round(applyNoise(n, this.noisePct, this.rng)))
  }

  private noisyMean(key: string): number | null {
    const acc = this.sums.get(key)
    if (!acc || acc.samples === 0) return null
    return Math.max(0, round1(applyNoise(acc.total / acc.samples, this.noisePct, this.rng)))
  }

  observe(
    dtMs: number,
    nowMs: number,
    cameras: readonly FixedCamera[],
    index: CoverageIndex,
    cars: readonly CarSample[],
  ): Reading[] {
    const seenBy = new Map<string, CarSample[]>()
    for (const camera of cameras) {
      const polygon = index.polygon(camera.id)
      const seen = polygon ? cars.filter((c) => insidePolygon(c, polygon)) : []
      seenBy.set(camera.id, seen)
      this.add(camera.id, seen)
      for (const { segmentId } of index.coveredBy(camera.id)) {
        this.add(`${camera.id}|${segmentId}`, seen.filter((c) => c.segmentId === segmentId))
      }
    }

    this.elapsed += dtMs
    if (this.elapsed < this.windowMs) return []
    this.elapsed -= this.windowMs

    const readings = cameras.map((camera): Reading => {
      const seen = seenBy.get(camera.id) ?? []
      const contagem = this.noisyCount(seen.length)
      const velocidadeMediaKmh = this.noisyMean(camera.id)
      const porTrecho: SegmentReading[] = []
      for (const { segmentId, cobertura } of index.coveredBy(camera.id)) {
        if (cobertura < COVERAGE_MIN) continue
        porTrecho.push({
          trecho: segmentId,
          contagem: this.noisyCount(seen.filter((c) => c.segmentId === segmentId).length),
          velocidadeMediaKmh: this.noisyMean(`${camera.id}|${segmentId}`),
          comprimentoCobertoM: round1(cobertura * index.lengthOf(segmentId)),
          cobertura: round3(cobertura),
        })
      }
      return {
        sensorId: camera.id,
        tipo: 'fixo',
        ts: nowMs,
        janelaS: this.windowMs / 1000,
        contagem,
        velocidadeMediaKmh,
        ruidoPct: this.noisePct,
        porTrecho,
      }
    })
    this.sums = new Map()
    return readings
  }
}
