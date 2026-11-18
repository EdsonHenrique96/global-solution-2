import { Simulation } from '../decision/Simulation'
import { SimulationEngine, TICK_MS, type Arrival } from '../sim/SimulationEngine'
import { FakeTransport } from '../telemetry/testing'

export const SCENARIOS = ['sem-sistema', 'notificar-todos', 'desvio-parcial'] as const
export type Scenario = (typeof SCENARIOS)[number]

export const RUN_MS = 900_000
export const RATE_PER_MINUTE = 15
export const ACCIDENT = { routeId: 'central', distance: 500, startMs: 300_000, durationMs: 120_000 } as const
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

/** First second after the accident from which the queue stays at or under the limit for 30 s. */
export function normalisationS(queueBySecond: number[], accidentS: number): number | null {
  const before = mean(queueBySecond.slice(0, accidentS)) ?? 0
  const limit = Math.max(1.2 * before, before + 1)
  for (let s = accidentS; s + NORMAL_HOLD_S <= queueBySecond.length; s++) {
    if (queueBySecond.slice(s, s + NORMAL_HOLD_S).every((q) => q <= limit)) return s - accidentS
  }
  return null
}

/** One scenario run, in chunks of `chunkTicks` so a page can stay responsive between them. */
export function* scenarioSteps(scenario: Scenario, seed: number, chunkTicks = 3_000): Generator<number, RunMetrics & { trace: Record<string, unknown> }> {
  const engine = new SimulationEngine({ ratePerMinute: RATE_PER_MINUTE, seed, arrivals: 'poisson' })
  const sim = new Simulation({ engine, transport: new FakeTransport(true), diversionMode: scenario === 'notificar-todos' ? 'todos' : 'parcial' })
  sim.setDiversionEnabled(scenario !== 'sem-sistema')
  engine.setAdaptiveSignals(scenario === 'desvio-parcial')
  sim.start()

  const arrivals: Arrival[] = []
  engine.onArrival((a) => arrivals.push(a))
  const queueBySecond: number[] = []
  let maxFraction = 0
  let altFlowMax: number | null = null
  let altCapacity: number | null = null
  const total = RUN_MS / TICK_MS
  for (let tick = 1; tick <= total; tick++) {
    if (engine.getState().timeMs === ACCIDENT.startMs) engine.addBlockage(ACCIDENT.routeId, ACCIDENT.distance)
    sim.tick()
    const { timeMs, diversion } = engine.getState()
    if (timeMs % 1000 === 0) queueBySecond.push(engine.queueTotal())
    if (diversion) {
      maxFraction = Math.max(maxFraction, diversion.fraction)
      if (timeMs % 10_000 === 0) {
        const alt = sim.capacity.routes()[diversion.to]
        if (alt && (altFlowMax === null || alt.fluxo > altFlowMax)) {
          altFlowMax = alt.fluxo
          altCapacity = alt.capacidade
        }
      }
    }
    if (tick % chunkTicks === 0) yield tick / total
  }
  sim.stop()

  const s = engine.getState()
  const metrics: RunMetrics = {
    tempoMedioViagemS: mean(arrivals.map((a) => a.travelS)),
    co2TotalKg: s.co2TotalG / 1000,
    co2GKm: s.distanceTotalM > 0 ? s.co2TotalG / (s.distanceTotalM / 1000) : null,
    tempoParadoMedioS: mean(arrivals.map((a) => a.paradoS)),
    filaMaxima: Math.max(0, ...queueBySecond),
    tempoNormalizarS: normalisationS(queueBySecond, ACCIDENT.startMs / 1000),
    saturacaoAlternativaPct: altFlowMax !== null && altCapacity ? (100 * altFlowMax) / altCapacity : null,
    desviadosPct: s.spawnedTotal ? (100 * s.divertedTotal) / s.spawnedTotal : 0,
  }
  return {
    ...metrics,
    trace: {
      seed,
      accident: { ...ACCIDENT },
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
export function runScenario(scenario: Scenario, seed: number): RunMetrics & { trace: Record<string, unknown> } {
  const steps = scenarioSteps(scenario, seed)
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

export interface ExperimentOptions {
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
export async function runExperiment({ repeticoes, onProgress, signal }: ExperimentOptions): Promise<{ results: RunResult[]; cancelado: boolean }> {
  const reps = clampRepetitions(repeticoes)
  const total = reps * SCENARIOS.length
  const results: RunResult[] = []
  const pause = () => new Promise<void>((r) => setTimeout(r, 0))
  for (let repeticao = 1; repeticao <= reps; repeticao++) {
    for (const cenario of SCENARIOS) {
      const steps = scenarioSteps(cenario, seedFor(repeticao))
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
