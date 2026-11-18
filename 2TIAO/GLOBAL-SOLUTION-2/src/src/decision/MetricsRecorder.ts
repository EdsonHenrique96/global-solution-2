import type { SimulationEngine } from '../sim/SimulationEngine'

export const SAMPLE_EVERY_MS = 10_000
export const KEEP_SAMPLES = 60

export interface MetricsSample {
  t: number
  travelS: number | null
  queue: number
  pctDiverted: number
}

export interface MetricsSnapshot {
  travelLastMinuteS: number | null
  travelAllS: number | null
  queueTotal: number
  pctDiverted: number
  samples: MetricsSample[]
}

/** Live metrics of the run, with one sample every 10 simulated seconds for the last 10 minutes. */
export class MetricsRecorder {
  private readonly engine: SimulationEngine
  private readonly samples: MetricsSample[] = []

  constructor(engine: SimulationEngine) {
    this.engine = engine
  }

  /** Call after every tick. */
  record(): void {
    const t = this.engine.getState().timeMs
    if (t === 0 || t % SAMPLE_EVERY_MS !== 0) return
    const now = this.current()
    this.samples.push({ t, travelS: now.travelLastMinuteS, queue: now.queueTotal, pctDiverted: now.pctDiverted })
    if (this.samples.length > KEEP_SAMPLES) this.samples.shift()
  }

  private current(): Omit<MetricsSnapshot, 'samples'> {
    const s = this.engine.getState()
    const travel = this.engine.travelStats()
    return {
      travelLastMinuteS: travel.lastMinuteAvgS,
      travelAllS: travel.allAvgS,
      queueTotal: this.engine.queueTotal(),
      pctDiverted: s.spawnedTotal ? (100 * s.divertedTotal) / s.spawnedTotal : 0,
    }
  }

  snapshot(): MetricsSnapshot {
    return { ...this.current(), samples: [...this.samples] }
  }
}
