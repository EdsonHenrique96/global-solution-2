import type { SimulationEngine } from '../sim/SimulationEngine'
import type { AppName } from '../sim/types'
import type { TelemetryTransport } from '../telemetry/transport'
import { APP_NAMES } from './apps'

export const APPS_TOPIC = 'transito/apps/ativos'
export const APPS_EVERY_MS = 10_000
/** Window over which the apps count their drivers entering each segment. */
export const DEMAND_WINDOW_MS = 60_000

/** What the map apps report, aggregated, every 10 s (door 4). */
export interface ActiveApps {
  ts: number
  /** Drivers with a map app open now (on the road or about to enter). */
  total: number
  porApp: Record<AppName, number>
  /** Drivers with an app on each segment now. */
  porTrecho: Record<string, number>
  /** Entries of app drivers in the last minute, scaled by the app share to all drivers, veh/h. */
  demandaPorTrecho: Record<string, number>
}

/**
 * Stands in for the map apps' platforms: they know their own drivers, and every 10 s publish only
 * aggregates (counts per app and per segment, demand per segment) - never a trip or a position.
 */
export class AppFleet {
  private readonly engine: SimulationEngine
  private readonly transport: TelemetryTransport
  private readonly share: number
  private entries: { segmentId: string; atMs: number }[] = []
  private readonly off: () => void
  last: ActiveApps | null = null

  constructor(engine: SimulationEngine, transport: TelemetryTransport, share: number) {
    this.engine = engine
    this.transport = transport
    this.share = share
    this.off = engine.onSegmentEntry((e) => {
      if (e.app) this.entries.push({ segmentId: e.segmentId, atMs: e.atMs })
    })
  }

  stop(): void {
    this.off()
  }

  /** The aggregate as of now. */
  snapshot(): ActiveApps {
    const { timeMs, cars } = this.engine.getState()
    const porApp = Object.fromEntries(APP_NAMES.map((a) => [a, 0])) as Record<AppName, number>
    const porTrecho: Record<string, number> = {}
    for (const car of [...cars, ...this.engine.waitingCars()]) {
      if (!car.app) continue
      porApp[car.app] += 1
    }
    for (const car of cars) {
      if (car.app) porTrecho[car.path[car.seg]] = (porTrecho[car.path[car.seg]] ?? 0) + 1
    }
    this.entries = this.entries.filter((e) => e.atMs > timeMs - DEMAND_WINDOW_MS)
    const perHour = 3_600_000 / DEMAND_WINDOW_MS
    const demandaPorTrecho: Record<string, number> = {}
    for (const e of this.entries) demandaPorTrecho[e.segmentId] = (demandaPorTrecho[e.segmentId] ?? 0) + perHour / this.share
    for (const id of Object.keys(demandaPorTrecho)) demandaPorTrecho[id] = Math.round(demandaPorTrecho[id] * 10) / 10
    const total = APP_NAMES.reduce((n, a) => n + porApp[a], 0)
    return { ts: timeMs, total, porApp, porTrecho, demandaPorTrecho }
  }

  /** Call after every tick: publishes the aggregate every 10 s, retained. */
  tick(): void {
    const { timeMs } = this.engine.getState()
    if (timeMs === 0 || timeMs % APPS_EVERY_MS !== 0) return
    this.last = this.snapshot()
    this.transport.publish(APPS_TOPIC, JSON.stringify(this.last), { qos: 0, retain: true })
  }
}
