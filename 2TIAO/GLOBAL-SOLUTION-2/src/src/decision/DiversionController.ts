import type { Exibicao } from '../render/levels'
import type { DiversionSimulation } from './simulateDiversion'

/** The diversion starts in the recomputation the segment turns Crítico (AD-090). */
export const START_WINDOWS = 1
export const STOP_WINDOWS = 2
export const MIN_CHANGE_INTERVAL_MS = 30_000

/** What the decision needs to know about a segment: its level (AD-082) and capacity figures. */
export interface RouteView {
  nivel: Exibicao
  velocidade: number | null
  /** Current flow, veh/h. */
  fluxo: number
  capacidade: number | null
  folga: number | null
}

export type DiversionState =
  | { status: 'inativo' }
  | { status: 'desligado' }
  | {
      status: 'ativo'
      /** The jammed segment drivers are told to avoid. */
      trecho: string
      n: number
      p: number
      /** Drivers with an app still heading into it (AC 22). */
      candidatos: number
      /** Notified in the last window. */
      notificados: number
      /** Drivers on it without an app (AC 26); null without a camera count. */
      semAlcance: number | null
      /** The fractions simulated for this diversion (door 6); null when everyone is told ("notificar todos"). */
      simulacao?: DiversionSimulation | null
    }

/**
 * When to divert, with hysteresis, evaluated once per 10 s recomputation: starts in the
 * recomputation a segment turns Crítico (AD-090, AD-082) and stops when it is out of Crítico, with
 * data, for 2 (AD-086), never changing within 30 s of the last change. Who is told and
 * where to go is the DriverRerouter's job.
 */
export class DiversionController {
  private congested = new Map<string, number>()
  private recovered = 0
  private active: string | null = null
  private lastChangeMs = -Infinity
  private enabled = true

  /** Congested for the decision: congested for START_WINDOWS windows in a row (AD-018). */
  private jammed(id: string): boolean {
    return (this.congested.get(id) ?? 0) >= START_WINDOWS
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) {
      this.active = null
      this.recovered = 0
    }
  }

  /** The jammed segment, or null. */
  evaluate(nowMs: number, segments: Record<string, RouteView>): string | null | 'desligado' {
    for (const [id, r] of Object.entries(segments)) {
      this.congested.set(id, r.nivel === 'critico' ? (this.congested.get(id) ?? 0) + 1 : 0)
    }
    if (!this.enabled) return 'desligado'
    const canChange = nowMs - this.lastChangeMs >= MIN_CHANGE_INTERVAL_MS

    if (this.active) {
      const a = segments[this.active]
      this.recovered = a && a.nivel !== 'critico' && a.nivel !== 'sem dado' ? this.recovered + 1 : 0
      if (this.recovered >= STOP_WINDOWS && canChange) {
        this.active = null
        this.recovered = 0
        this.lastChangeMs = nowMs
        return null
      }
      return this.active
    }

    // the most congested segment: longest run of congested windows, then id
    const jammed = [...this.congested].filter(([id]) => this.jammed(id)).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    if (jammed.length === 0 || !canChange) return null
    this.active = jammed[0][0]
    this.recovered = 0
    this.lastChangeMs = nowMs
    return this.active
  }
}
