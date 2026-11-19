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
/** Occupancy is the 5 min moving average of flow over capacity (AD-102), not the 1 min peak. */
export const OCCUPANCY_WINDOW_MS = 300_000
const DECIDE_EVERY_MS = 10_000

/** One fraction, simulated 10 min ahead (door 6). Occupancies in % of capacity. */
export interface FractionResult {
  fracao: number
  /** Highest 5 min moving average of flow over capacity on the segment, % (AD-102). */
  ocupacaoMaxTrecho: number
  /** The same on the segment of the alternatives that reaches the highest, %. */
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

/** One trajectory of the future: the fractions whose drivers were told the same so far share it. */
interface Branch {
  engine: SimulationEngine
  fracoes: number[]
  exits: Map<string, number[]>
  maxPct: Map<string, number>
  alternative: Set<string>
  travel: number[]
  where: Map<number, string>
}

function watch(b: Branch): Branch {
  b.engine.onArrival((a) => b.travel.push(a.travelS))
  return b
}

/** A branch that continues from `b` for `fracoes`: a copy of its engine and of what it measured. */
function fork(b: Branch, fracoes: number[]): Branch {
  return watch({
    engine: b.engine.clone({ cameras: false }),
    fracoes,
    exits: new Map([...b.exits].map(([k, v]) => [k, [...v]])),
    maxPct: new Map(b.maxPct),
    alternative: new Set(b.alternative),
    travel: [...b.travel],
    where: new Map(b.where),
  })
}

/**
 * Runs the engine 10 min ahead once per fraction: every 10 s, as the live diversion does, `fracao`
 * of the drivers heading into `trecho` are told to avoid it, with the speeds the panel knows now;
 * every 10 s each segment's 1 min flow (cars leaving it) is measured against its capacity. The
 * fractions run in lockstep from one copy and split into their own copy the first time they would
 * tell different drivers, so each fraction's result is that of its own independent run.
 */
function runFractions(live: SimulationEngine, frozen: Frozen): FractionResult[] {
  const start = live.getState()
  const end = start.timeMs + HORIZONTE_MIN * 60_000
  const segments = start.segments
  const segById = new Map(segments.map((s) => [s.id, s]))
  let branches: Branch[] = [
    watch({
      engine: live.clone({ cameras: false }),
      fracoes: [...FRACOES],
      exits: new Map(),
      maxPct: new Map(),
      alternative: new Set(),
      travel: [],
      where: new Map(start.cars.map((c) => [c.id, c.path[c.seg]])),
    }),
  ]
  for (let t = start.timeMs; t < end; t += TICK_MS) {
    if (t % DECIDE_EVERY_MS === 0) {
      const next: Branch[] = []
      for (const b of branches) {
        const s = b.engine.getState()
        const evaluations = candidatesFor([...s.cars, ...b.engine.waitingCars()], frozen.trecho, segById).map((c) => evaluate(c, segments, frozen.speedOf, frozen.trecho))
        for (const e of evaluations) if (e.ok && e.alternative) for (const id of e.alternative) if (!e.current.includes(id)) b.alternative.add(id)
        // the fractions that tell the same drivers stay together
        const groups = new Map<string, { fracoes: number[]; told: typeof evaluations }>()
        for (const f of b.fracoes) {
          const told = selectNotified(evaluations, 'parcial', f)
          const key = told.map((e) => e.carId).join(',')
          const g = groups.get(key)
          if (g) g.fracoes.push(f)
          else groups.set(key, { fracoes: [f], told })
        }
        const list = [...groups.values()]
        list.forEach((g, i) => {
          const branch = i === 0 ? b : fork(b, g.fracoes)
          branch.fracoes = g.fracoes
          for (const e of g.told) if (e.alternative) branch.engine.reroute(e.carId, e.alternative)
          next.push(branch)
        })
      }
      branches = next
    }
    for (const b of branches) {
      b.engine.tick(TICK_MS)
      const s = b.engine.getState()
      const now = new Map(s.cars.map((c) => [c.id, c.path[c.seg]]))
      for (const [id, seg] of b.where) {
        if (now.get(id) === seg) continue
        const list = b.exits.get(seg)
        if (list) list.push(s.timeMs)
        else b.exits.set(seg, [s.timeMs])
      }
      b.where = now
      if (s.timeMs % DECIDE_EVERY_MS === 0) {
        for (const [seg, list] of b.exits) {
          while (list.length && list[0] <= s.timeMs - OCCUPANCY_WINDOW_MS) list.shift()
          // only full windows: the first one ends 5 min into the horizon and covers it from the start
          if (s.timeMs - start.timeMs < OCCUPANCY_WINDOW_MS) continue
          const perHour = (list.length * 3_600_000) / OCCUPANCY_WINDOW_MS
          const pct = (perHour / frozen.capacityOf(seg)) * 100
          b.maxPct.set(seg, Math.max(b.maxPct.get(seg) ?? 0, pct))
        }
      }
    }
  }
  const round1 = (v: number) => Math.round(v * 10) / 10
  const results = new Map<number, FractionResult>()
  for (const b of branches) {
    b.alternative.delete(frozen.trecho)
    for (const fracao of b.fracoes) {
      results.set(fracao, {
        fracao,
        ocupacaoMaxTrecho: round1(b.maxPct.get(frozen.trecho) ?? 0),
        ocupacaoMaxAlternativa: round1(Math.max(0, ...[...b.alternative].map((id) => b.maxPct.get(id) ?? 0))),
        tempoMedioS: b.travel.length ? round1(b.travel.reduce((a, x) => a + x, 0) / b.travel.length) : null,
        co2Kg: Math.round((b.engine.getState().co2TotalG - start.co2TotalG) / 10) / 100,
      })
    }
  }
  return FRACOES.map((f) => results.get(f)!)
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
  const fracoes = runFractions(sim.engine, frozen)
  return { trecho, horizonteMin: HORIZONTE_MIN, fracoes, ...chooseFraction(fracoes) }
}
