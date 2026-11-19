import { CONFIGURED_CAPACITY_VEH_H } from '../capacity/CapacityModel'
import type { SimulationEngine } from '../sim/SimulationEngine'
import { TICK_MS } from '../sim/SimulationEngine'
import { candidatesFor, evaluate, selectNotified } from './DriverRerouter'
import type { Simulation } from './Simulation'

/** The fractions of drivers with an app that are told to avoid the segment (AC 13). */
export const FRACOES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 1] as const
export const HORIZONTE_MIN = 10
/** Below this predicted occupancy (%) a segment is relieved (UC01). */
export const OCUPACAO_LIMITE_PCT = 90
const WINDOW_MS = 60_000
const DECIDE_EVERY_MS = 10_000

/** One fraction, simulated 10 min ahead (door 6). Occupancies in % of capacity. */
export interface FractionResult {
  fracao: number
  /** Highest 1 min flow over capacity on the segment, %. */
  ocupacaoMaxTrecho: number
  /** Highest 1 min flow over capacity on any segment of the alternatives, %. */
  ocupacaoMaxAlternativa: number
  /** Mean travel time of the cars that arrived in the 10 min, s; null when none did. */
  tempoMedioS: number | null
  /** CO2 emitted in the 10 min by every car, kg. */
  co2Kg: number
}

/** Door 6. */
export interface DiversionSimulation {
  trecho: string
  horizonteMin: typeof HORIZONTE_MIN
  fracoes: FractionResult[]
  escolhida: number
  eficaz: boolean
}

/**
 * The smallest fraction with both occupancies below 90% (`eficaz`); without one, the fraction with
 * the lowest of the two maxima, the smallest on a tie (AC 15).
 */
export function chooseFraction(rows: readonly Pick<FractionResult, 'fracao' | 'ocupacaoMaxTrecho' | 'ocupacaoMaxAlternativa'>[]): { escolhida: number; eficaz: boolean } {
  const sorted = [...rows].sort((a, b) => a.fracao - b.fracao)
  const ok = sorted.find((r) => r.ocupacaoMaxTrecho < OCUPACAO_LIMITE_PCT && r.ocupacaoMaxAlternativa < OCUPACAO_LIMITE_PCT)
  if (ok) return { escolhida: ok.fracao, eficaz: true }
  const worst = (r: (typeof sorted)[number]) => Math.max(r.ocupacaoMaxTrecho, r.ocupacaoMaxAlternativa)
  const best = sorted.reduce((a, b) => (worst(b) < worst(a) ? b : a))
  return { escolhida: best.fracao, eficaz: false }
}

interface Frozen {
  trecho: string
  speedOf: (segmentId: string) => number | null
  capacityOf: (segmentId: string) => number
}

/**
 * Runs a copy of the engine 10 min ahead with `fracao` of the drivers heading into `trecho` told to
 * avoid it, every 10 s as the live diversion does, with the speeds the panel knows now. Measures each
 * segment's 1 min flow (cars leaving it) every 10 s against its capacity.
 */
function runFraction(clone: SimulationEngine, fracao: number, frozen: Frozen): FractionResult {
  const start = clone.getState()
  const startCo2 = start.co2TotalG
  const end = start.timeMs + HORIZONTE_MIN * 60_000
  const segments = start.segments
  const segById = new Map(segments.map((s) => [s.id, s]))
  const exits = new Map<string, number[]>()
  const maxPct = new Map<string, number>()
  const alternative = new Set<string>()
  const travel: number[] = []
  clone.onArrival((a) => travel.push(a.travelS))
  let where = new Map(start.cars.map((c) => [c.id, c.path[c.seg]]))
  while (clone.getState().timeMs < end) {
    const t0 = clone.getState().timeMs
    if (t0 % DECIDE_EVERY_MS === 0) {
      const s = clone.getState()
      const evaluations = candidatesFor([...s.cars, ...clone.waitingCars()], frozen.trecho, segById).map((c) => evaluate(c, segments, frozen.speedOf, frozen.trecho))
      for (const e of evaluations) if (e.ok && e.alternative) for (const id of e.alternative) if (!e.current.includes(id)) alternative.add(id)
      for (const e of selectNotified(evaluations, 'parcial', fracao)) if (e.alternative) clone.reroute(e.carId, e.alternative)
    }
    clone.tick(TICK_MS)
    const s = clone.getState()
    const now = new Map(s.cars.map((c) => [c.id, c.path[c.seg]]))
    for (const [id, seg] of where) {
      if (now.get(id) === seg) continue
      const list = exits.get(seg)
      if (list) list.push(s.timeMs)
      else exits.set(seg, [s.timeMs])
    }
    where = now
    if (s.timeMs % DECIDE_EVERY_MS === 0) {
      for (const [seg, list] of exits) {
        while (list.length && list[0] <= s.timeMs - WINDOW_MS) list.shift()
        const pct = ((list.length * 60) / frozen.capacityOf(seg)) * 100
        maxPct.set(seg, Math.max(maxPct.get(seg) ?? 0, pct))
      }
    }
  }
  alternative.delete(frozen.trecho)
  const round1 = (v: number) => Math.round(v * 10) / 10
  return {
    fracao,
    ocupacaoMaxTrecho: round1(maxPct.get(frozen.trecho) ?? 0),
    ocupacaoMaxAlternativa: round1(Math.max(0, ...[...alternative].map((id) => maxPct.get(id) ?? 0))),
    tempoMedioS: travel.length ? round1(travel.reduce((a, b) => a + b, 0) / travel.length) : null,
    co2Kg: Math.round((clone.getState().co2TotalG - startCo2) / 10) / 100,
  }
}

/**
 * RF18: for each fraction in FRACOES, a clone of the live engine runs 10 min ahead; the result is
 * door 6 with the smallest fraction that relieves the segment without jamming the alternative. The
 * live simulation is never touched (AC 14).
 */
export function simulateDiversion(sim: Simulation, trecho: string): DiversionSimulation {
  const estimates = sim.capacity.snapshot()
  const fused = sim.capacity.fusion.state()
  const frozen: Frozen = {
    trecho,
    speedOf: (id) => fused[id]?.velocidadeMedia ?? null,
    capacityOf: (id) => {
      const c = estimates[id]?.capacidade
      return c && c > 0 ? c : CONFIGURED_CAPACITY_VEH_H
    },
  }
  const fracoes = FRACOES.map((f) => runFraction(sim.engine.clone({ cameras: false }), f, frozen))
  return { trecho, horizonteMin: HORIZONTE_MIN, fracoes, ...chooseFraction(fracoes) }
}
