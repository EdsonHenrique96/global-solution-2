import { AppFleet } from '../apps/AppFleet'
import { AppNotifier, NOTIFICATIONS_FILTER } from '../apps/AppNotifier'
import { CapacityService } from '../capacity/CapacityService'
import { wireAlerts } from '../fusion/AlertPublisher'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { averageSpeed, readSegment } from '../render/levels'
import { TELEMETRY_FILTER, wireTelemetry } from '../telemetry/TelemetryPublisher'
import type { TelemetryTransport } from '../telemetry/transport'
import { DiversionController, diversionSize, type DiversionState } from './DiversionController'
import { candidatesFor, evaluate, outOfReach, selectNotified, type Evaluation } from './DriverRerouter'
import { IncidentLog } from './IncidentLog'
import { MetricsRecorder, SAMPLE_EVERY_MS } from './MetricsRecorder'
import { HISTORY_EVERY_MS, SegmentHistory } from './SegmentHistory'

export type DiversionMode = 'parcial' | 'todos'

interface Options {
  engine?: SimulationEngine
  transport: TelemetryTransport
  /**
   * When an agent applies the decisions (agente-aprovacao), the controller only suggests: the
   * diversion is applied by the agent's autonomy policy, not here.
   */
  agentControl?: boolean
  /** 'parcial' notifies at most ceil(p x candidates); 'todos' every driver with a faster alternative. */
  diversionMode?: DiversionMode
}

/** A diversion being applied: every 10 s window, the drivers heading into `trecho` are evaluated. */
export interface ActiveDiversion {
  trecho: string
  p: number
  mode: DiversionMode
}

/** How big a diversion of a segment would be now, and who it would reach. */
export interface Sizing {
  n: number
  p: number
  evaluations: Evaluation[]
}

/**
 * The whole loop: the engine, the capacity model fed by the broker, the map apps, the diversion
 * decision every 10 s window and the metrics. The page and the scenario tests run the same object.
 */
export class Simulation {
  readonly engine: SimulationEngine
  readonly capacity: CapacityService
  readonly metrics: MetricsRecorder
  readonly fleet: AppFleet
  readonly notifier: AppNotifier
  readonly history = new SegmentHistory()
  readonly incidents = new IncidentLog()
  /** Simulated time of each unit's last reading that came through the broker. */
  readonly unitLastReading: Record<string, number> = {}
  /** Route-change notices that went out through the broker to the drivers' map apps. */
  notifiedTotal = 0
  private readonly transport: TelemetryTransport
  private readonly controller = new DiversionController()
  private diversionEnabled = true
  private unwire: (() => void) | null = null
  /** The controller's suggestion, with its size. */
  diversion: DiversionState = { status: 'inativo' }
  active: ActiveDiversion | null = null

  readonly agentControl: boolean
  readonly diversionMode: DiversionMode

  constructor({ engine, transport, agentControl = false, diversionMode = 'parcial' }: Options) {
    this.agentControl = agentControl
    this.diversionMode = diversionMode
    this.engine = engine ?? new SimulationEngine()
    this.transport = transport
    this.capacity = new CapacityService(transport, () => this.engine.getState().timeMs, this.engine.getState().segments)
    this.fleet = new AppFleet(this.engine, transport, this.engine.getAppShare())
    this.notifier = new AppNotifier(transport)
    this.metrics = new MetricsRecorder(this.engine)
  }

  start(): void {
    this.capacity.start()
    if (!this.unwire) {
      const offTelemetry = wireTelemetry(this.engine, this.transport)
      const offAlerts = wireAlerts(this.engine, this.transport)
      const offPresence = this.transport.subscribe(TELEMETRY_FILTER, (_t, payload) => {
        try {
          const msg = JSON.parse(payload) as { sensorId?: unknown; ts?: unknown }
          if (typeof msg.sensorId === 'string' && typeof msg.ts === 'number') this.unitLastReading[msg.sensorId] = msg.ts
        } catch {
          // not a reading
        }
      })
      const offNotices = this.transport.subscribe(NOTIFICATIONS_FILTER, () => {
        this.notifiedTotal += 1
      })
      this.unwire = () => {
        offTelemetry()
        offAlerts()
        offPresence()
        offNotices()
      }
    }
  }

  stop(): void {
    this.capacity.stop()
    this.unwire?.()
    this.unwire = null
  }

  isDiversionEnabled(): boolean {
    return this.diversionEnabled
  }

  setDiversionEnabled(on: boolean): void {
    this.diversionEnabled = on
    this.controller.setEnabled(on)
    if (!on) {
      this.active = null
      this.diversion = { status: 'desligado' }
    } else if (this.diversion.status === 'desligado') {
      this.diversion = { status: 'inativo' }
    }
  }

  /** Applies a diversion from now on (the agent's or the operator's), or ends it with null. */
  setActiveDiversion(active: ActiveDiversion | null): void {
    this.active = active
  }

  tick(): void {
    this.engine.tick(TICK_MS)
    this.fleet.tick()
    this.metrics.record()
    const t = this.engine.getState().timeMs
    if (t % SAMPLE_EVERY_MS === 0) this.decide()
    if (t % HISTORY_EVERY_MS === 0) this.recordHistory(t)
    this.refreshIncidents()
  }

  /** Brings the incident log up to date now (after the operator ends one by hand). */
  refreshIncidents(): void {
    this.incidents.update(this.engine.getState(), this.diversion)
  }

  private recordHistory(t: number): void {
    const estimates = this.capacity.snapshot()
    const fused = this.capacity.fusion.state()
    const readings = this.capacity.segments.map((s) => readSegment(s.id, estimates[s.id], fused[s.id], t))
    const travel = this.engine.travelStats().lastMinuteAvgS
    this.history.record(
      t,
      Object.fromEntries(readings.map((r) => [r.id, { fluxo: r.fluxo, capacidade: r.capacidade, velocidade: r.velocidade }])),
      { avgSpeed: averageSpeed(readings), travelMin: travel === null ? null : travel / 60 },
    )
  }

  /**
   * The drivers with an app heading into `trecho`, each with the fastest alternative to their exit,
   * and the size of the diversion: N = min(excess, slack x 0.8) with the segment's demand from the
   * apps, its measured flow and the least slack among the alternatives' segments with a learned
   * capacity (no learned capacity: no slack limit); p = min(N / demand, 0.5).
   */
  sizing(trecho: string): Sizing {
    const estimates = this.capacity.snapshot()
    const fused = this.capacity.fusion.state()
    const segById = new Map(this.capacity.segments.map((s) => [s.id, s]))
    const drivers = [...this.engine.getState().cars, ...this.engine.waitingCars()]
    const speedOf = (id: string) => fused[id]?.velocidadeMedia ?? null
    const evaluations = candidatesFor(drivers, trecho, segById).map((c) => evaluate(c, this.capacity.segments, speedOf, trecho))
    const added = new Set(evaluations.flatMap((e) => (e.ok && e.alternative ? e.alternative.filter((id) => !e.current.includes(id)) : [])))
    const slacks = [...added].map((id) => estimates[id]?.folga).filter((f): f is number => f !== null && f !== undefined)
    const slack = slacks.length ? Math.min(...slacks) : Infinity
    const { n, p } = diversionSize(fused[trecho]?.demandaOD ?? 0, estimates[trecho]?.fluxo ?? 0, slack)
    return { n, p, evaluations }
  }

  /** Notifies this window's drivers and gives each the new path from the next corner. Returns how many. */
  private reroute(active: ActiveDiversion, sizing: Sizing): number {
    const now = this.engine.getState().timeMs
    let count = 0
    for (const e of selectNotified(sizing.evaluations, active.mode, active.p)) {
      if (!e.alternative || !this.engine.reroute(e.carId, e.alternative)) continue
      this.notifier.send(e.carId, e.app, active.trecho, e.alternative, e.gainS, now)
      count += 1
    }
    return count
  }

  private decide(): void {
    const jammed = this.controller.evaluate(this.engine.getState().timeMs, this.capacity.snapshot())
    const sizing = typeof jammed === 'string' && jammed !== 'desligado' ? this.sizing(jammed) : null
    if (!this.agentControl) {
      this.active = sizing ? { trecho: jammed as string, p: this.diversionMode === 'todos' ? 1 : sizing.p, mode: this.diversionMode } : null
    }
    // the diversion being applied (the controller's, or the agent's) reaches this window's drivers
    let notificados = 0
    if (this.active) notificados = this.reroute(this.active, sizing && this.active.trecho === jammed ? sizing : this.sizing(this.active.trecho))
    if (!sizing) {
      this.diversion = { status: jammed === 'desligado' ? 'desligado' : 'inativo' }
      return
    }
    const trecho = jammed as string
    this.diversion = {
      status: 'ativo',
      trecho,
      n: sizing.n,
      p: sizing.p,
      candidatos: sizing.evaluations.length,
      notificados,
      semAlcance: outOfReach(this.capacity.fusion.state()[trecho]?.contagem ?? null, this.fleet.snapshot().porTrecho[trecho] ?? 0),
    }
  }
}
