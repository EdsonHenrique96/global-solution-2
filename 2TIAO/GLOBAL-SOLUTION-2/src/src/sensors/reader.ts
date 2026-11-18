import { mulberry32 } from '../sim/random'
import { applyNoise } from '../telemetry/noise'
import { insidePolygon, type FixedCamera } from './camera'
import { COVERAGE_MIN, type CoverageIndex } from './coverage'

export const WINDOW_MS = 10_000
export const MAX_NOISE_PCT = 30
export const DEFAULT_NOISE_PCT = 10
export const DEFAULT_SEED = 42
/** The radar is more precise than the camera: it gets this share of the configured noise (AD-035). */
export const RADAR_NOISE_SHARE = 0.5

/** What one unit saw of one segment in a window (door 3). */
export interface SegmentReading {
  trecho: string
  /** Cars inside the camera's cone at the close of the window. */
  contagem: number
  fonteContagem: 'visao-computacional'
  /** Mean speed of the cars the radar measured in the window; null when it measured none. */
  velocidadeMediaKmh: number | null
  fonteVelocidade: 'radar'
  /** Car samples the radar took in the window (one per car per tick). */
  amostrasRadar: number
  /** Segment length inside the camera's cone, metres. */
  comprimentoCobertoM: number
  cobertura: number
}

/** One unit's reading for a closed window - the telemetry payload (door 3). */
export interface Reading {
  sensorId: string
  tipo: 'camera+radar'
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
 * Every tick, each unit's camera sees the cars inside its cone and its radar measures the speed of
 * the cars inside its beam - and only those (AC 9). When a window closes it reports per unit the
 * cars in the cone at the close and the mean radar speed, and the same per segment the camera
 * covers at least COVERAGE_MIN of. The radar gets half the camera's noise.
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

  private add(key: string, measured: readonly CarSample[]) {
    const acc = this.sums.get(key) ?? { total: 0, samples: 0 }
    for (const s of measured) {
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
    return Math.max(0, round1(applyNoise(acc.total / acc.samples, this.noisePct * RADAR_NOISE_SHARE, this.rng)))
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
      const cone = index.polygon(camera.id)
      const beam = index.beam(camera.id)
      seenBy.set(camera.id, cone ? cars.filter((c) => insidePolygon(c, cone)) : [])
      const measured = beam ? cars.filter((c) => insidePolygon(c, beam)) : []
      this.add(camera.id, measured)
      for (const { segmentId } of index.coveredBy(camera.id)) {
        this.add(`${camera.id}|${segmentId}`, measured.filter((c) => c.segmentId === segmentId))
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
          fonteContagem: 'visao-computacional',
          velocidadeMediaKmh: this.noisyMean(`${camera.id}|${segmentId}`),
          fonteVelocidade: 'radar',
          amostrasRadar: this.sums.get(`${camera.id}|${segmentId}`)?.samples ?? 0,
          comprimentoCobertoM: round1(cobertura * index.lengthOf(segmentId)),
          cobertura: round3(cobertura),
        })
      }
      return {
        sensorId: camera.id,
        tipo: 'camera+radar',
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
