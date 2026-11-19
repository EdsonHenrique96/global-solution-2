import { AppFleet } from '../apps/AppFleet'
import { AppNotifier, NOTIFICATIONS_FILTER } from '../apps/AppNotifier'
import { CapacityService } from '../capacity/CapacityService'
import { wireAlerts } from '../fusion/AlertPublisher'
import { monitoredSegments, PlateMatcher } from '../fusion/PlateMatcher'
import { CAMERA_STATUS_FILTER, wirePlateCameras } from '../sensors/PlateCamera'
import { SimulationEngine, TICK_MS, type Blockage } from '../sim/SimulationEngine'
import { ruleClassifier, type SegmentClassifier } from '../capacity/SegmentClassifier'
import { averageSpeed, readSegment, type SegmentReading } from '../render/levels'
import type { TelemetryTransport } from '../telemetry/transport'
import { DiversionController, type DiversionState } from './DiversionController'
import { candidatesFor, evaluate, outOfReach, selectNotified, VERIFICATION_KMH, type Evaluation } from './DriverRerouter'
import { inThreadRunner, type FractionRunner } from './fractionRunner'
import { rerouterSpeed, simulateDiversion, type DiversionSimulation } from './simulateDiversion'
import { ForecastClient, type Prever, type PrevisaoEvento } from '../forecast/ForecastClient'
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
  /** The one state rule (AD-082); V2 swaps in the K-means here. */
  classifier?: SegmentClassifier
  /** How a partial diversion is sized: the fractions simulated ahead (RF18); injected in tests. */
  simulateDiversion?: (sim: Simulation, trecho: string) => DiversionSimulation
  /** The ML service's forecast (door 2); without it there is no forecast (experiments, tests). */
  prever?: Prever
  /** Where the fraction simulation runs (AD-103): a Web Worker in the page; by default here, synchronously. */
  fractionRunner?: FractionRunner
}

/** A simulated diversion is reused for the same segment for this long when no diversion holds it. */
export const SIMULATION_REUSE_MS = 60_000
const KEEP_LOG = 200

/** One 10 s window of a diversion being applied (experiments and tests read it). */
export interface DiversionWindow {
  t: number
  trecho: string
  p: number
  candidatos: number
  /** Candidates whose alternative passes (AC 23 of the rerouter). */
  aptos: number
  notificados: number
}

/** A diversion being applied: every 10 s window, the drivers heading into `trecho` are evaluated. */
export interface ActiveDiversion {
  trecho: string
  p: number
  mode: DiversionMode
}

/** How big a diversion of a segment would be now, and who it would reach. */
export interface Sizing {
  /** Drivers diverted, veh/h: p x the segment's demand. */
  n: number
  /** The fraction told to avoid the segment: the smallest effective one simulated (RF18). */
  p: number
  evaluations: Evaluation[]
  /** The fractions simulated for this segment (door 6). */
  simulacao: DiversionSimulation
}

/**
 * The whole loop: the engine and its plate cameras, the plate matcher, the capacity model fed by
 * the broker, the map apps, the diversion decision every 10 s window and the metrics. The page and
 * the scenario tests run the same object.
 */
export class Simulation {
  readonly engine: SimulationEngine
  readonly capacity: CapacityService
  readonly metrics: MetricsRecorder
  readonly fleet: AppFleet
  readonly notifier: AppNotifier
  readonly history = new SegmentHistory()
  readonly incidents = new IncidentLog()
  /** Pairs the cameras' plate events and publishes each segment's metrics (door 2). */
  readonly matcher: PlateMatcher
  /** Simulated time of each camera's last status that came through the broker. */
  readonly cameraLastStatus: Record<string, number> = {}
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
  /** Classifies every segment for the map, the panels and the diversion alike (AD-082). */
  readonly classifier: SegmentClassifier
  /** Every fraction simulation run, oldest first (the last 200). */
  readonly simulations: { t: number; result: DiversionSimulation }[] = []
  /** Every 10 s window a diversion was applied in, oldest first (the last 200). */
  readonly windows: DiversionWindow[] = []
  private readonly runner: FractionRunner
  /** Fraction simulations by segment: asked for, then answered (`result`). */
  private readonly fractions = new Map<string, { t: number; result: DiversionSimulation | null }>()
  /** Segments with an open "Possível incidente" warning, and those the operator confirmed (AD-104). */
  private warned = new Set<string>()
  private readonly confirmed = new Set<string>()
  /** Blockages the operator registered on the map (AD-110): known at once, not waiting for the cameras. */
  private readonly reported = new Set<number>()
  /** Forecasts of the paired segments every 60 s (RF16); null without the ML service. */
  readonly forecast: ForecastClient | null
  private readonly forecastListeners = new Set<(e: PrevisaoEvento) => void>()

  constructor({ engine, transport, agentControl = false, diversionMode = 'parcial', classifier = ruleClassifier, simulateDiversion: simulate = simulateDiversion, prever, fractionRunner }: Options) {
    this.classifier = classifier
    this.runner = fractionRunner ?? inThreadRunner(simulate)
    this.agentControl = agentControl
    this.diversionMode = diversionMode
    this.engine = engine ?? new SimulationEngine()
    this.transport = transport
    const now = () => this.engine.getState().timeMs
    this.capacity = new CapacityService(transport, now, this.engine.getState().segments)
    this.matcher = new PlateMatcher(transport, now, monitoredSegments(this.engine.getState().cameras))
    this.fleet = new AppFleet(this.engine, transport, this.engine.getAppShare())
    this.notifier = new AppNotifier(transport)
    this.metrics = new MetricsRecorder(this.engine)
    this.forecast = prever
      ? new ForecastClient({
          prever,
          segments: monitoredSegments(this.engine.getState().cameras).map((m) => m.trecho),
          history: this.history,
          capacityOf: (id) => this.capacity.snapshot()[id]?.capacidade ?? null,
          onEvent: (e) => {
            for (const l of this.forecastListeners) l(e)
          },
        })
      : null
  }

  /** Door 5: a segment forecast to reach 90% of its capacity in 15 min, once per crossing (V3 subscribes). */
  onPrevisao(listener: (e: PrevisaoEvento) => void): () => void {
    this.forecastListeners.add(listener)
    return () => this.forecastListeners.delete(listener)
  }

  start(): void {
    this.capacity.start()
    this.matcher.start()
    if (!this.unwire) {
      const offCameras = wirePlateCameras(this.engine, this.transport)
      const offAlerts = wireAlerts(this.engine, this.transport)
      const offPresence = this.transport.subscribe(CAMERA_STATUS_FILTER, (_t, payload) => {
        try {
          const msg = JSON.parse(payload) as { cameraId?: unknown; ts?: unknown }
          if (typeof msg.cameraId === 'string' && typeof msg.ts === 'number') this.cameraLastStatus[msg.cameraId] = msg.ts
        } catch {
          // not a status
        }
      })
      const offNotices = this.transport.subscribe(NOTIFICATIONS_FILTER, () => {
        this.notifiedTotal += 1
      })
      this.unwire = () => {
        offCameras()
        offAlerts()
        offPresence()
        offNotices()
      }
    }
  }

  stop(): void {
    this.capacity.stop()
    this.matcher.stop()
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
    this.matcher.tick()
    this.fleet.tick()
    this.metrics.record()
    const t = this.engine.getState().timeMs
    this.trackWarnings()
    if (t % SAMPLE_EVERY_MS === 0) this.decide()
    if (t % HISTORY_EVERY_MS === 0) this.recordHistory(t)
    this.forecast?.tick(t)
    this.refreshIncidents()
  }

  /** Every segment's reading and level now, by the one classifier (AD-082). */
  readings(): Record<string, SegmentReading> {
    const t = this.engine.getState().timeMs
    const estimates = this.capacity.snapshot()
    const fused = this.capacity.fusion.state()
    const accidents = this.reportedAccidents()
    return Object.fromEntries(
      this.capacity.segments.map((s) => {
        const r = readSegment(s.id, estimates[s.id], fused[s.id], t, this.classifier)
        // an accident the operator registered is Crítico from the click until it expires or is
        // cleared, whatever the cameras measure (AD-110)
        if (accidents.has(s.id)) return [s.id, { ...r, exibido: 'critico' as const }]
        // a confirmed incident is a blocked segment: Crítico for the map and the decision (AD-104)
        return [s.id, this.confirmed.has(s.id) && r.exibido === 'verificacao' ? { ...r, exibido: 'critico' as const } : r]
      }),
    )
  }

  /**
   * Registers an accident the operator created on the map (AD-110): the segment is blocked and counts
   * as Crítico at once - on the map and for the diversion, decided now - until the block expires or is
   * removed. Returns the blockage. An accident injected straight into the engine (the experiments) is
   * not known: the system finds it through the cameras.
   */
  reportAccident(segmentId: string, distance: number, durationMs?: number): Blockage {
    const b = this.engine.addBlockage(segmentId, distance, durationMs)
    this.reported.add(b.id)
    this.refreshIncidents()
    this.decide()
    return b
  }

  /**
   * The speed the routes read for each segment: a segment in verification (AD-104) or with a
   * registered accident (AD-110) crawls at 2 km/h; the others, the measured speed.
   */
  routeSpeeds(fused = this.capacity.fusion.state()): (segmentId: string) => number | null {
    const accidents = this.reportedAccidents()
    return (id) => (accidents.has(id) ? VERIFICATION_KMH : rerouterSpeed(fused[id]))
  }

  /** The segments with a registered accident still active; forgets the ones that ended. */
  private reportedAccidents(): Set<string> {
    const active = new Map(this.engine.getState().blockages.map((b) => [b.id, b.segmentId]))
    const segments = new Set<string>()
    for (const id of this.reported) {
      const seg = active.get(id)
      if (seg === undefined) this.reported.delete(id)
      else segments.add(seg)
    }
    return segments
  }

  /** Whether the operator (or, in V4, the drone) confirmed the incident on `trecho`. */
  isConfirmed(trecho: string): boolean {
    return this.confirmed.has(trecho)
  }

  /**
   * Confirms the "Possível incidente" of `trecho` (AD-104): from now on it counts as Crítico, and the
   * decision runs at once with the fractions computed when the warning opened. The operator's
   * button calls it now; V4's drone will. False when the segment has no open warning.
   */
  confirmIncident(trecho: string): boolean {
    if (!this.warned.has(trecho)) return false
    this.confirmed.add(trecho)
    this.decide()
    return true
  }

  /**
   * A warning that opens starts its fraction simulation and applies nothing (AD-104); one that closes
   * ends its confirmation and, unless a diversion holds the segment, discards the computation.
   */
  private trackWarnings(): void {
    const fused = this.capacity.fusion.state()
    const now = new Set(Object.keys(fused).filter((id) => fused[id].possivelIncidente))
    for (const id of now) {
      if (this.warned.has(id)) continue
      if (this.diversionEnabled && this.diversionMode === 'parcial') {
        this.warned.add(id)
        this.fractionsFor(id)
      }
    }
    for (const id of this.warned) {
      if (now.has(id)) continue
      this.confirmed.delete(id)
      if (!this.holds(id)) this.fractions.delete(id)
    }
    this.warned = now
  }

  /** A diversion (suggested or applied) is on `trecho`. */
  private holds(trecho: string): boolean {
    return (this.diversion.status === 'ativo' && this.diversion.trecho === trecho) || this.active?.trecho === trecho
  }

  /** Brings the incident log up to date now (after the operator ends one by hand). */
  refreshIncidents(): void {
    const fused = this.capacity.fusion.state()
    const anomalies = Object.keys(fused).filter((id) => fused[id].possivelIncidente)
    this.incidents.update(this.engine.getState(), this.diversion, anomalies, this.forecast?.predicted() ?? [])
  }

  private recordHistory(t: number): void {
    const readings = Object.values(this.readings())
    const travel = this.engine.travelStats().lastMinuteAvgS
    this.history.record(
      t,
      Object.fromEntries(readings.map((r) => [r.id, { fluxo: r.fluxo, capacidade: r.capacidade, velocidade: r.velocidade, densidade: r.densidade }])),
      { avgSpeed: averageSpeed(readings), travelMin: travel === null ? null : travel / 60 },
    )
  }

  /**
   * The fractions simulated ahead for `trecho` (door 6), or null while they are being computed. Asked
   * when a warning opens or a diversion starts, and kept while the warning or the diversion lasts (a
   * minute otherwise, for the agent's repeated questions).
   */
  fractionsFor(trecho: string): DiversionSimulation | null {
    const t = this.engine.getState().timeMs
    const known = this.fractions.get(trecho)
    if (known && (known.result === null || this.holds(trecho) || this.warned.has(trecho) || t - known.t < SIMULATION_REUSE_MS)) return known.result
    const entry: { t: number; result: DiversionSimulation | null } = { t, result: null }
    this.fractions.set(trecho, entry)
    const done = (result: DiversionSimulation) => {
      // discarded meanwhile (the warning closed unconfirmed): nothing to keep
      if (this.fractions.get(trecho) !== entry) return
      entry.result = result
      this.simulations.push({ t, result })
      if (this.simulations.length > KEEP_LOG) this.simulations.shift()
    }
    const answer = this.runner.run(this, trecho)
    if (answer instanceof Promise) answer.then(done, () => this.fractions.get(trecho) === entry && this.fractions.delete(trecho))
    else done(answer)
    return entry.result
  }

  /** Same as fractionsFor (kept for callers that read it as the diversion's simulation). */
  diversionSimulation(trecho: string): DiversionSimulation | null {
    return this.fractionsFor(trecho)
  }

  /** The drivers with an app heading into `trecho`, each with the fastest alternative to their exit. */
  private evaluations(trecho: string): Evaluation[] {
    const fused = this.capacity.fusion.state()
    const segById = new Map(this.capacity.segments.map((s) => [s.id, s]))
    const drivers = [...this.engine.getState().cars, ...this.engine.waitingCars()]
    const speedOf = this.routeSpeeds(fused)
    return candidatesFor(drivers, trecho, segById).map((c) => evaluate(c, this.capacity.segments, speedOf, trecho))
  }

  /**
   * Who a diversion of `trecho` would reach and its size: p is the smallest effective fraction
   * simulated ahead (RF18, replacing N/p by the slack), N = p x the segment's demand from the apps.
   */
  sizing(trecho: string): Sizing | null {
    const simulacao = this.fractionsFor(trecho)
    if (!simulacao) return null
    const p = simulacao.escolhida
    const demand = this.capacity.fusion.state()[trecho]?.demandaOD ?? 0
    return { n: Math.round(p * demand * 10) / 10, p, evaluations: this.evaluations(trecho), simulacao }
  }

  /** Notifies this window's drivers and gives each the new path from the next corner. Returns how many. */
  private reroute(active: ActiveDiversion, evaluations: Evaluation[]): number {
    const now = this.engine.getState().timeMs
    let count = 0
    for (const e of selectNotified(evaluations, active.mode, active.p)) {
      if (!e.alternative || !this.engine.reroute(e.carId, e.alternative)) continue
      this.notifier.send(e.carId, e.app, active.trecho, e.alternative, e.gainS, now)
      count += 1
    }
    this.windows.push({ t: now, trecho: active.trecho, p: active.p, candidatos: evaluations.length, aptos: evaluations.filter((e) => e.ok).length, notificados: count })
    if (this.windows.length > KEEP_LOG) this.windows.shift()
    return count
  }

  private decide(): void {
    const estimates = this.capacity.snapshot()
    const levels = this.readings()
    // a segment "Em verificação" does not count as Crítico: it never starts a diversion, and one
    // active on it ends by the normal rule (AD-100, AD-086) - unless the incident was confirmed,
    // which readings() shows as Crítico (AD-104)
    const views = Object.fromEntries(Object.entries(estimates).map(([id, e]) => [id, { ...e, nivel: levels[id].exibido }]))
    const jammed = this.controller.evaluate(this.engine.getState().timeMs, views)
    const trecho = typeof jammed === 'string' && jammed !== 'desligado' ? jammed : null
    // "notificar todos" tells everyone with a faster alternative: no fraction to simulate
    const todos = this.diversionMode === 'todos'
    const sizing = trecho && !todos ? this.sizing(trecho) : null
    const evaluations = trecho ? (sizing?.evaluations ?? this.evaluations(trecho)) : []
    const p = todos ? 1 : (sizing?.p ?? 0)
    if (!this.agentControl) {
      this.active = trecho ? { trecho, p, mode: this.diversionMode } : null
    }
    // the diversion being applied (the controller's, or the agent's) reaches this window's drivers
    let notificados = 0
    if (this.active) notificados = this.reroute(this.active, this.active.trecho === trecho ? evaluations : this.evaluations(this.active.trecho))
    if (!trecho) {
      this.diversion = { status: jammed === 'desligado' ? 'desligado' : 'inativo' }
      return
    }
    this.diversion = {
      status: 'ativo',
      trecho,
      n: sizing?.n ?? 0,
      p,
      candidatos: evaluations.length,
      notificados,
      semAlcance: outOfReach(this.capacity.fusion.state()[trecho]?.contagem ?? null, this.fleet.snapshot().porTrecho[trecho] ?? 0),
      simulacao: sizing?.simulacao ?? null,
      // the fractions are still being computed (in the worker): nobody told yet
      calculando: !todos && !sizing,
    }
  }
}
