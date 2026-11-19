import { CYCLE_MS, GREEN_MS } from '../sim/trafficLight'

export const SPEED_LIMIT_KMH = 50
export const LANES = 1
export const FORGETTING = 0.98
/** The learned capacity replaces the configured one only after this many samples with a valid fit (AD-087). */
export const MIN_SAMPLES = 30
/**
 * Saturation flow of one lane, veh/h: measured, a standing queue discharges one car every ~1.86 s
 * at green with the IDM of AD-096 (checked by the capacity test against the engine).
 */
export const SATURATION_FLOW_VEH_H = 1940
/** Every segment's capacity from the start: saturation flow x green / cycle (AD-087). */
export const CONFIGURED_CAPACITY_VEH_H = (SATURATION_FLOW_VEH_H * GREEN_MS) / CYCLE_MS
export const STALE_AFTER_MS = 20_000
export const MAX_PLOTTED = 200

/** One segment's metrics from the plate pairs (door 2): density, pair speed and measured flow. */
export interface ViaInput {
  densidadeVeicKm: number
  velocidadeMediaKmh: number | null
  /** Measured flow, veh/h. */
  fluxoVeicH: number
}

export interface Sample {
  /** Density, veh/km. */
  k: number
  /** Flow, veh/h. */
  q: number
}

export interface Estimate {
  /** No metrics for more than 20 s (or never). */
  semDados: boolean
  /** Last reading: density (veh/km), speed (km/h, null when nobody was seen) and flow (veh/h). */
  densidade: number | null
  velocidade: number | null
  fluxo: number
  vf: number | null
  kj: number | null
  /** The configured capacity until the fit is learned (AD-087); never null. */
  capacidade: number
  capacidadeFonte: 'configurada' | 'aprendida'
  folga: number | null
  amostras: Sample[]
}

/**
 * Greenshields fitted online: v = vf (1 - k / kj) is linear in k, so recursive least squares on
 * v = a + b k gives vf = a and kj = -a / b; capacity is vf kj / 4.
 */
export class CapacityModel {
  private theta: [number, number] = [0, 0]
  private P: [[number, number], [number, number]] = [
    [1e6, 0],
    [0, 1e6],
  ]
  private fitted = 0
  private samples: Sample[] = []
  private last: { k: number; v: number | null; q: number; ts: number } | null = null

  static slack(capacity: number, flow: number): number {
    return capacity - flow
  }

  observe(input: ViaInput, ts: number): void {
    const k = input.densidadeVeicKm / LANES
    const v = input.velocidadeMediaKmh
    const q = input.fluxoVeicH
    if (!Number.isFinite(k) || !Number.isFinite(q)) return
    // a reading that arrives late still trains the fit, but never rewinds the current state
    if (this.last === null || ts >= this.last.ts) this.last = { k, v, q, ts }
    if (v === null) return
    this.samples.push({ k, q })
    if (this.samples.length > MAX_PLOTTED) this.samples.shift()
    this.update(k, v)
  }

  private update(k: number, v: number): void {
    const x: [number, number] = [1, k]
    const P = this.P
    const Px: [number, number] = [P[0][0] * x[0] + P[0][1] * x[1], P[1][0] * x[0] + P[1][1] * x[1]]
    const denom = FORGETTING + x[0] * Px[0] + x[1] * Px[1]
    const gain: [number, number] = [Px[0] / denom, Px[1] / denom]
    const err = v - (this.theta[0] * x[0] + this.theta[1] * x[1])
    this.theta = [this.theta[0] + gain[0] * err, this.theta[1] + gain[1] * err]
    // P = (P - g x^T P) / lambda ; x^T P = Px^T because P is symmetric
    this.P = [
      [(P[0][0] - gain[0] * Px[0]) / FORGETTING, (P[0][1] - gain[0] * Px[1]) / FORGETTING],
      [(P[1][0] - gain[1] * Px[0]) / FORGETTING, (P[1][1] - gain[1] * Px[1]) / FORGETTING],
    ]
    this.fitted += 1
  }

  /** `nowMs` is simulated time; metrics older than 20 s leave the segment without data. */
  estimate(nowMs: number): Estimate {
    const [a, b] = this.theta
    // a fit whose capacity exceeds the saturation flow is not a road (AD-106): keep the configured one
    const known = this.fitted >= MIN_SAMPLES && b < -1e-6 && a > 0 && (a * (-a / b)) / 4 <= SATURATION_FLOW_VEH_H
    const vf = known ? a : null
    const kj = known ? -a / b : null
    const capacidade = known ? (a * (-a / b)) / 4 : CONFIGURED_CAPACITY_VEH_H
    const fresh = this.last !== null && nowMs - this.last.ts <= STALE_AFTER_MS
    const fluxo = this.last?.q ?? 0
    return {
      semDados: !fresh,
      densidade: this.last?.k ?? null,
      velocidade: this.last?.v ?? null,
      fluxo,
      vf,
      kj,
      capacidade,
      capacidadeFonte: known ? 'aprendida' : 'configurada',
      folga: this.last === null ? null : CapacityModel.slack(capacidade, fluxo),
      amostras: [...this.samples],
    }
  }
}
