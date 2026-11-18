import type { RouteStatus } from '../capacity/CapacityModel'

export const SAFETY_FACTOR = 0.8
export const MAX_DIVERSION = 0.5
export const START_WINDOWS = 2
export const STOP_WINDOWS = 2
export const STOP_SPEED_KMH = 35
export const MIN_CHANGE_INTERVAL_MS = 30_000

/** What the decision needs to know about a route (from the capacity model). */
export interface RouteView {
  estado: RouteStatus
  velocidade: number | null
  /** Current flow, veh/h. */
  fluxo: number
  capacidade: number | null
  folga: number | null
}

export type DiversionState =
  | { status: 'inativo' }
  | { status: 'desligado' }
  | { status: 'sem-alternativa'; from: string }
  | { status: 'ativo'; from: string; to: string; n: number; p: number }

/** N = min(excess of A, slack of B x 0.8); p = min(N / demand of A, 0.5). Rates in veh/h. */
export function diversionSize(demandA: number, flowA: number, slackB: number): { n: number; p: number } {
  const excess = Math.max(0, demandA - flowA)
  const n = Math.max(0, Math.min(excess, slackB * SAFETY_FACTOR))
  const p = demandA > 0 ? Math.min(n / demandA, MAX_DIVERSION) : 0
  return { n: Math.round(n * 10) / 10, p: Math.round(p * 1000) / 1000 }
}

/**
 * Partial diversion with hysteresis, evaluated once per 10 s window: starts when a route is
 * congested for 2 windows (and some other route has capacity and slack), stops when it is back
 * at 35 km/h or more for 2 windows, never changing within 30 s of the last change.
 */
export class DiversionController {
  private congested = new Map<string, number>()
  private recovered = 0
  private active: { from: string; to: string } | null = null
  private lastChangeMs = -Infinity
  private enabled = true

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) {
      this.active = null
      this.recovered = 0
    }
  }

  evaluate(nowMs: number, routes: Record<string, RouteView>, demandVehH: Record<string, number>): DiversionState {
    for (const [id, r] of Object.entries(routes)) {
      this.congested.set(id, r.estado === 'congestionado' ? (this.congested.get(id) ?? 0) + 1 : 0)
    }
    if (!this.enabled) return { status: 'desligado' }
    const canChange = nowMs - this.lastChangeMs >= MIN_CHANGE_INTERVAL_MS

    if (this.active) {
      const a = routes[this.active.from]
      const v = a?.velocidade
      this.recovered = a && (v === null || v >= STOP_SPEED_KMH) && a.estado !== 'sem dados' ? this.recovered + 1 : 0
      if (this.recovered >= STOP_WINDOWS && canChange) {
        this.active = null
        this.recovered = 0
        this.lastChangeMs = nowMs
        return { status: 'inativo' }
      }
      const b = routes[this.active.to]
      const { n, p } = diversionSize(demandVehH[this.active.from] ?? 0, a?.fluxo ?? 0, b?.folga ?? 0)
      return { status: 'ativo', ...this.active, n, p }
    }

    // the most congested candidate: longest run of congested windows
    const candidates = [...this.congested].filter(([, c]) => c >= START_WINDOWS).sort((x, y) => y[1] - x[1])
    if (candidates.length === 0) return { status: 'inativo' }
    const from = candidates[0][0]
    const alternatives = Object.entries(routes)
      .filter(([id, r]) => id !== from && r.capacidade !== null && r.folga !== null && r.folga > 0)
      .sort((x, y) => y[1].folga! - x[1].folga!)
    if (alternatives.length === 0) return { status: 'sem-alternativa', from }
    if (!canChange) return { status: 'inativo' }
    const [to, b] = alternatives[0]
    this.active = { from, to }
    this.recovered = 0
    this.lastChangeMs = nowMs
    const { n, p } = diversionSize(demandVehH[from] ?? 0, routes[from].fluxo, b.folga!)
    return { status: 'ativo', from, to, n, p }
  }
}
