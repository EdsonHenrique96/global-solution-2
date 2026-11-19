import type { SegmentHistory } from '../decision/SegmentHistory'
import { clockAt, type ClockTime, SIM_START } from '../sim/clock'

/** Door 2, in: the last 10 min of each paired segment, one sample per minute, oldest first. */
export interface PrevisaoEntrada {
  diaSemana: number
  horaMin: number
  trechos: Record<string, { v: number[]; f: number[]; d: number[] }>
}

/** Speed (km/h) and flow (cars/min) 15 and 30 min ahead. */
export interface Previsao {
  v15: number
  f15: number
  v30: number
  f30: number
}

/** Door 2, out. */
export interface PrevisaoSaida {
  modelo: string
  previsoes: Record<string, Previsao>
}

export type Prever = (body: PrevisaoEntrada) => Promise<PrevisaoSaida>

/** Door 5: a segment predicted to reach 90% of its capacity in 15 min (occupancies in %). */
export interface PrevisaoEvento {
  tipo: 'previsao'
  trecho: string
  ts: number
  ocupacao15: number
  ocupacao30: number
  v15: number
  f15: number
}

/** A segment listed as "Congestionamento previsto". */
export interface Previsto {
  trecho: string
  /** When the forecast was made. */
  ts: number
  /** When the jam is expected: 15 min after the forecast. */
  previstoPara: number
  ocupacao15: number
}

export const FORECAST_EVERY_MS = 60_000
/** The first call waits for 10 min of history (door 2). */
export const FIRST_FORECAST_MS = 600_000
export const LAGS = 10
/** "Previsão indisponível" after this many failed calls in a row (AC 10). */
export const FAILURES_UNAVAILABLE = 3
/** Enters "Congestionamento previsto" at 90% and leaves below 80% (AC 11). */
export const ENTER_PCT = 90
export const EXIT_PCT = 80
export const HORIZON_15_MS = 15 * 60_000
/** A segment without a pair speed: -1 (door 2). */
export const SEM_VELOCIDADE = -1

/** 'aguardando': no answer yet; 'ok': the last answer is shown; 'indisponivel': 3 failures in a row. */
export type ForecastStatus = 'aguardando' | 'ok' | 'indisponivel'

interface Options {
  prever: Prever
  /** The paired segments: the only ones with lags (AD-023). */
  segments: readonly string[]
  history: SegmentHistory
  /** Each segment's capacity now, veh/h. */
  capacityOf: (segmentId: string) => number | null
  onEvent: (e: PrevisaoEvento) => void
  start?: ClockTime
}

/** f x 60 / capacity, in %, to one decimal (AC 11). */
export const forecastOccupancy = (fluxoVeicMin: number, capacidadeVeicH: number | null) =>
  capacidadeVeicH && capacidadeVeicH > 0 ? Math.round((fluxoVeicMin * 60 * 1000) / capacidadeVeicH) / 10 : 0

/**
 * Asks the ML service for every paired segment's forecast every 60 simulated seconds, keeps the
 * last answer, marks the segments heading to 90% of their capacity and tells the subscribers once
 * per crossing (door 5). An answer older than one already applied is dropped.
 */
export class ForecastClient {
  status: ForecastStatus = 'aguardando'
  /** The last forecast applied, by segment, and when its request was made. */
  previsoes: Record<string, Previsao> = {}
  previsoesEm: number | null = null
  private readonly previstos = new Map<string, Previsto>()
  private readonly opts: Options
  private sent = 0
  private applied = 0
  private failures = 0

  constructor(opts: Options) {
    this.opts = opts
  }

  /** Call after every tick; it asks on each 60 s mark from 10 min on. */
  tick(t: number): void {
    if (t < FIRST_FORECAST_MS || t % FORECAST_EVERY_MS !== 0) return
    const body = this.body(t)
    if (Object.keys(body.trechos).length === 0) return
    const seq = ++this.sent
    let answer: Promise<PrevisaoSaida>
    try {
      answer = this.opts.prever(body)
    } catch (e) {
      answer = Promise.reject(e)
    }
    answer.then(
      (r) => this.apply(seq, t, r),
      () => this.fail(seq),
    )
  }

  /** Door 2 body for the 60 s mark `t`: the history at t - 540 s ... t. */
  body(t: number): PrevisaoEntrada {
    const { diaSemana, horaMin } = clockAt(t, this.opts.start ?? SIM_START)
    const trechos: PrevisaoEntrada['trechos'] = {}
    for (const id of this.opts.segments) {
      const byT = new Map(this.opts.history.of(id).map((p) => [p.t, p]))
      const v: number[] = []
      const f: number[] = []
      const d: number[] = []
      for (let i = LAGS - 1; i >= 0; i--) {
        const p = byT.get(t - i * FORECAST_EVERY_MS)
        if (!p) break
        v.push(p.velocidade === null ? SEM_VELOCIDADE : p.velocidade)
        f.push(p.fluxo === null ? 0 : p.fluxo / 60)
        d.push(p.densidade ?? 0)
      }
      if (v.length === LAGS) trechos[id] = { v, f, d }
    }
    return { diaSemana, horaMin, trechos }
  }

  /** The segments listed as "Congestionamento previsto". */
  predicted(): Previsto[] {
    return [...this.previstos.values()]
  }

  private apply(seq: number, t: number, r: PrevisaoSaida): void {
    // an older request answering late never replaces a newer forecast
    if (seq < this.applied) return
    this.applied = seq
    this.failures = 0
    this.status = 'ok'
    this.previsoes = r.previsoes
    this.previsoesEm = t
    for (const [trecho, p] of Object.entries(r.previsoes)) {
      const cap = this.opts.capacityOf(trecho)
      const ocupacao15 = forecastOccupancy(p.f15, cap)
      const ocupacao30 = forecastOccupancy(p.f30, cap)
      const known = this.previstos.get(trecho)
      if (!known && ocupacao15 >= ENTER_PCT) {
        this.previstos.set(trecho, { trecho, ts: t, previstoPara: t + HORIZON_15_MS, ocupacao15 })
        this.opts.onEvent({ tipo: 'previsao', trecho, ts: t, ocupacao15, ocupacao30, v15: p.v15, f15: p.f15 })
      } else if (known && ocupacao15 < EXIT_PCT) {
        this.previstos.delete(trecho)
      } else if (known) {
        this.previstos.set(trecho, { ...known, ts: t, previstoPara: t + HORIZON_15_MS, ocupacao15 })
      }
    }
  }

  private fail(seq: number): void {
    if (seq < this.applied) return
    this.failures += 1
    if (this.failures >= FAILURES_UNAVAILABLE) {
      this.status = 'indisponivel'
      this.previstos.clear()
    }
  }
}
