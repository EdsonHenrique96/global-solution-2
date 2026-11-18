import type { SimulationEngine } from '../sim/SimulationEngine'
import type { TelemetryTransport } from '../telemetry/transport'

export const OD_TOPIC = 'transito/demanda/od'
export const OD_WINDOW_MS = 60_000
/** Cells with fewer trips are dropped, so no small group can be singled out (LGPD). */
export const OD_MIN_TRIPS = 5

export interface OdCell {
  origem: string
  destino: string
  viagens: number
}

/**
 * Stands in for a mobile operator: every 60 s it publishes how many trips started in each
 * origin -> destination cell, aggregated, dropping cells under OD_MIN_TRIPS. The network has one
 * origin (oeste) and one destination (leste).
 */
export class OdAggregator {
  private readonly engine: SimulationEngine
  private readonly transport: TelemetryTransport
  private lastTotal = 0

  constructor(engine: SimulationEngine, transport: TelemetryTransport) {
    this.engine = engine
    this.transport = transport
  }

  /** Call after every tick. */
  tick(): void {
    const { timeMs, spawnedTotal } = this.engine.getState()
    if (timeMs === 0 || timeMs % OD_WINDOW_MS !== 0) return
    const trips = spawnedTotal - this.lastTotal
    this.lastTotal = spawnedTotal
    const cells: OdCell[] = trips >= OD_MIN_TRIPS ? [{ origem: 'oeste', destino: 'leste', viagens: trips }] : []
    const msg = { ts: timeMs, janelaS: OD_WINDOW_MS / 1000, celulas: cells }
    this.transport.publish(OD_TOPIC, JSON.stringify(msg), { qos: 0, retain: false })
  }
}
