export type RouteState = 'fluindo' | 'carregado' | 'congestionado'
export type RouteStatus = RouteState | 'sem dados'

export const SPEED_LIMIT_KMH = 50
export const LANES = 1
export const FORGETTING = 0.98
export const MIN_SAMPLES = 5
export const STALE_AFTER_MS = 20_000
export const MAX_PLOTTED = 200

/** One via's slice of a drone reading, as it arrives in the payload. */
export interface ViaInput {
  contagem: number
  velocidadeMediaKmh: number | null
  comprimentoM: number
}

export interface Sample {
  /** Density, veh/km. */
  k: number
  /** Flow, veh/h. */
  q: number
}

export interface Estimate {
  estado: RouteStatus
  /** Last reading: density (veh/km), speed (km/h, null when nobody was seen) and flow (veh/h). */
  densidade: number | null
  velocidade: number | null
  fluxo: number
  vf: number | null
  kj: number | null
  capacidade: number | null
  folga: number | null
  amostras: Sample[]
}

/** State from speed over the speed limit (AD-006). An empty road flows. */
export function classify(speedKmh: number | null): RouteState {
  if (speedKmh === null) return 'fluindo'
  const ratio = speedKmh / SPEED_LIMIT_KMH
  if (ratio >= 0.8) return 'fluindo'
  if (ratio >= 0.5) return 'carregado'
  return 'congestionado'
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
    if (!(input.comprimentoM > 0)) return
    const k = input.contagem / ((input.comprimentoM / 1000) * LANES)
    const v = input.velocidadeMediaKmh
    const q = v === null ? 0 : k * v
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

  /** `nowMs` is simulated time; a reading older than 20 s leaves the route "sem dados". */
  estimate(nowMs: number): Estimate {
    const [a, b] = this.theta
    const known = this.fitted >= MIN_SAMPLES && b < -1e-6 && a > 0
    const vf = known ? a : null
    const kj = known ? -a / b : null
    const capacidade = known ? (a * (-a / b)) / 4 : null
    const fresh = this.last !== null && nowMs - this.last.ts <= STALE_AFTER_MS
    const fluxo = this.last?.q ?? 0
    return {
      estado: fresh ? classify(this.last!.v) : 'sem dados',
      densidade: this.last?.k ?? null,
      velocidade: this.last?.v ?? null,
      fluxo,
      vf,
      kj,
      capacidade,
      folga: capacidade === null || this.last === null ? null : CapacityModel.slack(capacidade, fluxo),
      amostras: [...this.samples],
    }
  }
}
