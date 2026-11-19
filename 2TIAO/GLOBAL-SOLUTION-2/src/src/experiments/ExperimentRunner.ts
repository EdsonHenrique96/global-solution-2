import { Simulation } from '../decision/Simulation'
import type { DiversionSimulation } from '../decision/simulateDiversion'
import { DEFAULT_RATE_PER_MINUTE, SimulationEngine, TICK_MS, type Arrival } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'

export const SCENARIOS = ['sem-sistema', 'notificar-todos', 'desvio-parcial'] as const
export type Scenario = (typeof SCENARIOS)[number]

/** 25 simulated minutes: the accident's queue has time to settle at the default demand (AD-085). */
export const RUN_MS = 1_500_000
export const RATE_PER_MINUTE = DEFAULT_RATE_PER_MINUTE
/** Al. Santos, R. Bela Cintra → R. Haddock Lobo, in the middle of the block (AC 31). */
export const ACCIDENT = { segmentId: 'I12>I13', startMs: 300_000 } as const
export const ACCIDENT_MINUTES = [2, 5] as const
/** The accident is confirmed this long after its "Possível incidente" warning opens, as V4's drone will (AD-104). */
export const CONFIRM_AFTER_MS = 60_000
/** From the default demand (AD-081) to its double, as in the V1 demonstration. */
export const DEMAND_MIN = DEFAULT_RATE_PER_MINUTE
export const DEMAND_MAX = 2 * DEFAULT_RATE_PER_MINUTE

/** What the operator chooses before a run (semaforo-coordenado AC 4). */
export interface ExperimentParams {
  acidenteMin: (typeof ACCIDENT_MINUTES)[number]
  demanda: number
}
export const DEFAULT_PARAMS: ExperimentParams = { acidenteMin: 2, demanda: RATE_PER_MINUTE }

/** Demand kept within DEMAND_MIN-DEMAND_MAX cars/min. */
export const clampDemand = (n: number) => Math.min(DEMAND_MAX, Math.max(DEMAND_MIN, Math.round(Number.isFinite(n) ? n : RATE_PER_MINUTE)))
const NORMAL_HOLD_S = 30

export interface RunMetrics {
  tempoMedioViagemS: number | null
  co2TotalKg: number
  co2GKm: number | null
  tempoParadoMedioS: number | null
  filaMaxima: number
  tempoNormalizarS: number | null
  saturacaoAlternativaPct: number | null
  desviadosPct: number
  /**
   * The fraction told to avoid the segment: none without the system, 1 when notifying everyone, the
   * one simulateDiversion chose at the first trigger in the partial diversion (null if it never fired).
   */
  fracaoDesvio?: number | null
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * Seconds from the accident until the queue is normal again: from the first second after the
 * accident at which the queue goes over the limit, the first second from which it stays at or
 * under the limit for 30 s. 0 when the queue never goes over; null when it never comes back.
 */
export function normalisationS(queueBySecond: number[], accidentS: number): number | null {
  const before = mean(queueBySecond.slice(0, accidentS)) ?? 0
  const limit = Math.max(1.2 * before, before + 1)
  const over = queueBySecond.findIndex((q, s) => s >= accidentS && q > limit)
  if (over === -1) return 0
  // queueBySecond[i] is the queue at the end of second i + 1
  for (let s = over; s + NORMAL_HOLD_S <= queueBySecond.length; s++) {
    if (queueBySecond.slice(s, s + NORMAL_HOLD_S).every((q) => q <= limit)) return s + 1 - accidentS
  }
  return null
}

/** One scenario run, in chunks of `chunkTicks` so a page can stay responsive between them. */
export function* scenarioSteps(
  scenario: Scenario,
  seed: number,
  params: ExperimentParams = DEFAULT_PARAMS,
  chunkTicks = 250,
  simulate?: (sim: Simulation, trecho: string) => DiversionSimulation,
): Generator<number, RunMetrics & { trace: Record<string, unknown> }> {
  const demanda = clampDemand(params.demanda)
  const engine = new SimulationEngine({ ratePerMinute: demanda, seed, arrivals: 'poisson' })
  const sim = new Simulation({ engine, transport: new FakeTransport(true), diversionMode: scenario === 'notificar-todos' ? 'todos' : 'parcial', simulateDiversion: simulate })
  sim.setDiversionEnabled(scenario !== 'sem-sistema')
  engine.setAdaptiveSignals(scenario === 'desvio-parcial')
  sim.start()

  const arrivals: Arrival[] = []
  engine.onArrival((a) => arrivals.push(a))
  // what the engine itself did with the accident, not what this runner meant to do
  const blockages: { segmentId: string; distance: number; ativo: boolean; ts: number }[] = []
  engine.onBlockage((e) => blockages.push({ segmentId: e.blockage.segmentId, distance: e.blockage.distance, ativo: e.ativo, ts: e.ts }))
  const accidentAt = engine.segment(ACCIDENT.segmentId)!.length / 2
  // alternatives: every segment but the accident's, sampled every 10 s in every scenario (AD-030)
  const altFlowMax: Record<string, number> = {}
  const queueBySecond: number[] = []
  // the accident's warning, and its confirmation 60 s later while it is still open
  let avisoEm: number | null = null
  let confirmadoEm: number | null = null
  const total = RUN_MS / TICK_MS
  for (let tick = 1; tick <= total; tick++) {
    if (engine.getState().timeMs === ACCIDENT.startMs) engine.addBlockage(ACCIDENT.segmentId, accidentAt, params.acidenteMin * 60_000)
    sim.tick()
    const { timeMs } = engine.getState()
    const warned = sim.capacity.fusion.state()[ACCIDENT.segmentId]?.possivelIncidente ?? false
    if (warned && avisoEm === null) avisoEm = timeMs
    if (!warned && confirmadoEm === null) avisoEm = null
    if (avisoEm !== null && confirmadoEm === null && timeMs - avisoEm >= CONFIRM_AFTER_MS && sim.confirmIncident(ACCIDENT.segmentId)) confirmadoEm = timeMs
    if (timeMs % 1000 === 0) queueBySecond.push(engine.queueTotal())
    if (timeMs % 10_000 === 0) {
      for (const [id, e] of Object.entries(sim.capacity.snapshot())) {
        if (id !== ACCIDENT.segmentId && !e.semDados) altFlowMax[id] = Math.max(altFlowMax[id] ?? 0, e.fluxo)
      }
    }
    if (tick % chunkTicks === 0) yield tick / total
  }
  // saturation: each alternative's peak flow over its capacity learned by the end of the run
  const finalEstimates = sim.capacity.snapshot()
  const altCapacity: Record<string, number | null> = Object.fromEntries(Object.keys(altFlowMax).map((id) => [id, finalEstimates[id]?.capacidade ?? null]))
  const ratios = Object.keys(altFlowMax)
    .filter((id) => altCapacity[id])
    .map((id) => (100 * altFlowMax[id]) / (altCapacity[id] as number))
  sim.stop()

  const s = engine.getState()
  const metrics: RunMetrics = {
    tempoMedioViagemS: mean(arrivals.map((a) => a.travelS)),
    co2TotalKg: s.co2TotalG / 1000,
    co2GKm: s.distanceTotalM > 0 ? s.co2TotalG / (s.distanceTotalM / 1000) : null,
    tempoParadoMedioS: mean(arrivals.map((a) => a.paradoS)),
    filaMaxima: Math.max(0, ...queueBySecond),
    tempoNormalizarS: normalisationS(queueBySecond, ACCIDENT.startMs / 1000),
    saturacaoAlternativaPct: ratios.length ? Math.max(...ratios) : null,
    desviadosPct: s.spawnedTotal ? (100 * s.reroutedTotal) / s.spawnedTotal : 0,
    fracaoDesvio: scenario === 'sem-sistema' ? null : scenario === 'notificar-todos' ? 1 : (sim.simulations[0]?.result.escolhida ?? null),
  }
  return {
    ...metrics,
    trace: {
      seed,
      blockages,
      demanda,
      acidenteMin: params.acidenteMin,
      spawned: s.spawnedTotal,
      notified: sim.notifier.total,
      rerouted: s.reroutedTotal,
      adaptiveSignals: scenario === 'desvio-parcial',
      diversionEnabled: scenario !== 'sem-sistema',
      diversionMode: scenario === 'notificar-todos' ? 'todos' : 'parcial',
      arrivals: arrivals.map((a) => ({ travelS: a.travelS, co2G: a.co2G, distanciaM: a.distanciaM, paradoS: a.paradoS })),
      co2TotalG: s.co2TotalG,
      distanceTotalM: s.distanceTotalM,
      queueBySecond,
      altFlowMax,
      altCapacity,
      // what the decision did: each fraction simulation and each 10 s window it was applied in
      simulacoes: sim.simulations.map((x) => ({ t: x.t, ...x.result })),
      avisoEm,
      confirmadoEm,
      janelas: [...sim.windows],
    },
  }
}

/** One scenario run to the end (tests and scripts). */
export function runScenario(
  scenario: Scenario,
  seed: number,
  params: ExperimentParams = DEFAULT_PARAMS,
  simulate?: (sim: Simulation, trecho: string) => DiversionSimulation,
): RunMetrics & { trace: Record<string, unknown> } {
  const steps = scenarioSteps(scenario, seed, params, 250, simulate)
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

export interface RunResult {
  cenario: Scenario
  repeticao: number
  semente: number
  metrics: RunMetrics
}

/** Seed of a repetition: the same in the three scenarios, different across repetitions. */
export const seedFor = (repeticao: number) => 1000 + repeticao

export interface ExperimentOptions extends Partial<ExperimentParams> {
  repeticoes: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** Clamp of the repetitions the panel accepts. */
export const clampRepetitions = (n: number) => Math.min(30, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)))

/**
 * Runs every scenario `repeticoes` times, yielding to the page between chunks so it stays
 * responsive. Cancelling keeps the runs already finished.
 */
export async function runExperiment({ repeticoes, onProgress, signal, acidenteMin = 2, demanda = RATE_PER_MINUTE }: ExperimentOptions): Promise<{ results: RunResult[]; cancelado: boolean }> {
  const reps = clampRepetitions(repeticoes)
  const total = reps * SCENARIOS.length
  const results: RunResult[] = []
  const pause = () => new Promise<void>((r) => setTimeout(r, 0))
  for (let repeticao = 1; repeticao <= reps; repeticao++) {
    for (const cenario of SCENARIOS) {
      const steps = scenarioSteps(cenario, seedFor(repeticao), { acidenteMin, demanda })
      for (;;) {
        if (signal?.aborted) return { results, cancelado: true }
        const r = steps.next()
        if (r.done) {
          const { trace: _trace, ...metrics } = r.value
          void _trace
          results.push({ cenario, repeticao, semente: seedFor(repeticao), metrics })
          onProgress?.(results.length, total)
          break
        }
        await pause()
      }
    }
  }
  return { results, cancelado: false }
}
