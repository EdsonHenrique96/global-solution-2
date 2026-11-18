import { CapacityService } from '../capacity/CapacityService'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { wireAlerts } from '../fusion/AlertPublisher'
import { OdAggregator } from '../fusion/OdAggregator'
import { FULL_COVERAGE } from '../fusion/confidence'
import type { FusedSegment } from '../fusion/FusionService'
import type { Segment } from '../sensors/segments'
import { wireTelemetry } from '../telemetry/TelemetryPublisher'
import type { TelemetryTransport } from '../telemetry/transport'
import { DiversionController, type DiversionState, type RouteView } from './DiversionController'
import { MetricsRecorder, SAMPLE_EVERY_MS } from './MetricsRecorder'

interface Options {
  engine?: SimulationEngine
  transport: TelemetryTransport
}

/**
 * Demand of each route from the OD matrix (fusao-trechos): the demand of its first middle segment,
 * veh/h; unknown -> 0, so the diversion's N is 0.
 */
export function routeDemand(
  routeIds: readonly string[],
  fused: Record<string, FusedSegment>,
  segments: readonly Segment[],
): Record<string, number> {
  return Object.fromEntries(
    routeIds.map((id) => {
      const middle = segments.find((s) => s.routeIds.length === 1 && s.routeIds[0] === id && !s.id.endsWith('-entrada'))
      return [id, (middle && fused[middle.id]?.demandaOD) ?? 0]
    }),
  )
}

/** Confidence in a route: its least trusted segment; a segment without data counts as 0. */
export function routeConfidence(routeId: string, fused: Record<string, FusedSegment>, segments: readonly Segment[]): number {
  return Math.min(...segments.filter((s) => s.routeIds.includes(routeId)).map((s) => fused[s.id]?.confianca ?? 0))
}

/**
 * The whole loop: the engine, the capacity model fed by the broker, the diversion decision every
 * 10 s window and the metrics. The page and the scenario tests run the same object.
 */
export class Simulation {
  readonly engine: SimulationEngine
  readonly capacity: CapacityService
  readonly metrics: MetricsRecorder
  private readonly transport: TelemetryTransport
  private readonly controller = new DiversionController()
  private diversionEnabled = true
  private unwire: (() => void) | null = null
  private readonly od: OdAggregator
  diversion: DiversionState = { status: 'inativo' }

  constructor({ engine, transport }: Options) {
    this.engine = engine ?? new SimulationEngine()
    this.transport = transport
    this.capacity = new CapacityService(transport, () => this.engine.getState().timeMs, this.engine.getState().segments)
    this.od = new OdAggregator(this.engine, transport)
    this.metrics = new MetricsRecorder(this.engine)
  }

  start(): void {
    this.capacity.start()
    if (!this.unwire) {
      const offTelemetry = wireTelemetry(this.engine, this.transport)
      const offAlerts = wireAlerts(this.engine, this.transport)
      this.unwire = () => {
        offTelemetry()
        offAlerts()
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
      this.engine.setDiversion(null)
      this.diversion = { status: 'desligado' }
    } else if (this.diversion.status === 'desligado') {
      this.diversion = { status: 'inativo' }
    }
  }

  tick(): void {
    this.engine.tick(TICK_MS)
    this.od.tick()
    this.metrics.record()
    if (this.engine.getState().timeMs % SAMPLE_EVERY_MS === 0) this.decide()
  }

  /** The demand per route the diversion uses now, veh/h. */
  demand(): Record<string, number> {
    return routeDemand(Object.keys(this.capacity.routes()), this.capacity.fusion.state(), this.capacity.segments)
  }

  private decide(): void {
    const routes: Record<string, RouteView> = this.capacity.routes()
    const fused = this.capacity.fusion.state()
    const segments = this.capacity.segments
    const demand = routeDemand(Object.keys(routes), fused, segments)
    this.diversion = this.controller.evaluate(this.engine.getState().timeMs, routes, demand)
    if (this.diversion.status === 'ativo') {
      const confianca = routeConfidence((this.diversion as { to: string }).to, fused, segments)
      this.diversion = {
        ...this.diversion,
        confianca,
        ...(confianca < FULL_COVERAGE ? { aviso: 'rota alternativa com trechos sem cobertura' } : {}),
      }
    }
    const d = this.diversion
    this.engine.setDiversion(d.status === 'ativo' && d.p > 0 ? { from: d.from, to: d.to, fraction: d.p } : null)
  }
}
