import { CapacityService } from '../capacity/CapacityService'
import { SimulationEngine, TICK_MS } from '../sim/SimulationEngine'
import { wireTelemetry } from '../telemetry/TelemetryPublisher'
import type { TelemetryTransport } from '../telemetry/transport'
import { DiversionController, type DiversionState, type RouteView } from './DiversionController'
import { MetricsRecorder, SAMPLE_EVERY_MS } from './MetricsRecorder'

interface Options {
  engine?: SimulationEngine
  transport: TelemetryTransport
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
  diversion: DiversionState = { status: 'inativo' }

  constructor({ engine, transport }: Options) {
    this.engine = engine ?? new SimulationEngine()
    this.transport = transport
    this.capacity = new CapacityService(transport, () => this.engine.getState().timeMs, this.engine.getState().segments)
    this.metrics = new MetricsRecorder(this.engine)
  }

  start(): void {
    this.capacity.start()
    this.unwire ??= wireTelemetry(this.engine, this.transport)
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
    this.metrics.record()
    if (this.engine.getState().timeMs % SAMPLE_EVERY_MS === 0) this.decide()
  }

  private decide(): void {
    const routes: Record<string, RouteView> = this.capacity.routes()
    // demand of each route: its round-robin share of the generation rate, veh/h
    const perRoute = (this.engine.getRate() * 60) / Object.keys(routes).length
    const demand = Object.fromEntries(Object.keys(routes).map((id) => [id, perRoute]))
    this.diversion = this.controller.evaluate(this.engine.getState().timeMs, routes, demand)
    const d = this.diversion
    this.engine.setDiversion(d.status === 'ativo' && d.p > 0 ? { from: d.from, to: d.to, fraction: d.p } : null)
  }
}
