import { Simulation } from '../decision/Simulation'
import { SimulationEngine, TICK_MS, type Arrival } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'

export const SCENARIOS = ['sem-sistema', 'notificar-todos', 'desvio-parcial'] as const
export type Scenario = (typeof SCENARIOS)[number]

export const RUN_MS = 900_000
export const RATE_PER_MINUTE = 15
export const ACCIDENT = { routeId: 'central', distance: 500, startMs: 300_000 } as const
export const ACCIDENT_MINUTES = [2, 5] as const
export const DEMAND_MIN = 10
export const DEMAND_MAX = 20

/** What the operator chooses before a run (semaforo-coordenado AC 4). */
export interface ExperimentParams {
  acidenteMin: (typeof ACCIDENT_MINUTES)[number]
  demanda: number
}
export const DEFAULT_PARAMS: ExperimentParams = { acidenteMin: 2, demanda: RATE_PER_MINUTE }

/** Demand kept within 10-20 cars/min. */
export const clampDemand = (n: number) => Math.min(DEMAND_MAX, Math.max(DEMAND_MIN, Math.round(Number.isFinite(n) ? n : 15)))
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
): Generator<number, RunMetrics & { trace: Record<string, unknown> }> {
  const demanda = clampDemand(params.demanda)
  const engine = new SimulationEngine({ ratePerMinute: demanda, seed, arrivals: 'poisson' })
  const sim = new Simulation({ engine, transport: new FakeTransport(true), diversionMode: scenario === 'notificar-todos' ? 'todos' : 'parcial' })
  sim.setDiversionEnabled(scenario !== 'sem-sistema')
  engine.setAdaptiveSignals(scenario === 'desvio-parcial')
  sim.start()

  const arrivals: Arrival[] = []
  engine.onArrival((a) => arrivals.push(a))
  // what the engine itself did with the accident, not what this runner meant to do
  const blockages: { routeId: string; distance: number; ativo: boolean; ts: number }[] = []
  engine.onBlockage((e) => blockages.push({ routeId: e.blockage.routeId, distance: e.blockage.distance, ativo: e.ativo, ts: e.ts }))
  // alternatives: the routes without the accident, sampled every 10 s in every scenario (AD-030)
  const altFlowMax: Record<string, number> = {}
  const queueBySecond: number[] = []
  let maxFraction = 0
  const total = RUN_MS / TICK_MS
  for (let tick = 1; tick <= total; tick++) {
    if (engine.getState().timeMs === ACCIDENT.startMs) engine.addBlockage(ACCIDENT.routeId, ACCIDENT.distance, params.acidenteMin * 60_000)
    sim.tick()
    const { timeMs, diversion } = engine.getState()
    if (timeMs % 1000 === 0) queueBySecond.push(engine.queueTotal())
    if (diversion) maxFraction = Math.max(maxFraction, diversion.fraction)
    if (timeMs % 10_000 === 0) {
      for (const [id, r] of Object.entries(sim.capacity.routes())) {
        if (id !== ACCIDENT.routeId) altFlowMax[id] = Math.max(altFlowMax[id] ?? 0, r.fluxo)
      }
    }
    if (tick % chunkTicks === 0) yield tick / total
  }
  // saturation: each alternative's peak flow over its capacity learned by the end of the run
  const finalRoutes = sim.capacity.routes()
  const altCapacity: Record<string, number | null> = Object.fromEntries(Object.keys(altFlowMax).map((id) => [id, finalRoutes[id]?.capacidade ?? null]))
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
    desviadosPct: s.spawnedTotal ? (100 * s.divertedTotal) / s.spawnedTotal : 0,
  }
  return {
    ...metrics,
    trace: {
      seed,
      blockages,
      demanda,
      acidenteMin: params.acidenteMin,
      spawned: s.spawnedTotal,
      diverted: s.divertedTotal,
      adaptiveSignals: scenario === 'desvio-parcial',
      diversionEnabled: scenario !== 'sem-sistema',
      diversionMode: scenario === 'notificar-todos' ? 'todos' : 'parcial',
      maxFraction,
      arrivals: arrivals.map((a) => ({ travelS: a.travelS, co2G: a.co2G, distanciaM: a.distanciaM, paradoS: a.paradoS })),
      co2TotalG: s.co2TotalG,
      distanceTotalM: s.distanceTotalM,
      queueBySecond,
      altFlowMax,
      altCapacity,
    },
  }
}

/** One scenario run to the end (tests and scripts). */
export function runScenario(scenario: Scenario, seed: number, params: ExperimentParams = DEFAULT_PARAMS): RunMetrics & { trace: Record<string, unknown> } {
  const steps = scenarioSteps(scenario, seed, params)
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
