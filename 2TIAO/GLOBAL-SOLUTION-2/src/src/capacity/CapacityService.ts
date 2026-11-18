import { buildSegments, type Segment } from '../sensors/segments'
import { buildCityNetwork } from '../sim/cityNetwork'
import { FusionService } from '../fusion/FusionService'
import type { TelemetryTransport } from '../telemetry/transport'
import { CapacityModel, type Estimate } from './CapacityModel'

/**
 * One capacity model per road segment (AD-022), fed by the fusion layer, which only reads the MQTT
 * subscription (AD-005): one chosen measurement per segment and window. `now` is the simulation
 * clock, so staleness keeps counting while the broker is down.
 */
export class CapacityService {
  private readonly now: () => number
  readonly segments: readonly Segment[]
  private readonly models: Map<string, CapacityModel>
  /** The fusion layer the models learn from (fusao-trechos). */
  readonly fusion: FusionService

  constructor(transport: TelemetryTransport, now: () => number, segments?: readonly Segment[]) {
    this.now = now
    this.segments = segments ?? buildSegments(buildCityNetwork())
    this.models = new Map(this.segments.map((s) => [s.id, new CapacityModel()]))
    this.fusion = new FusionService(transport, now, this.segments)
  }

  start(): void {
    this.fusion.start()
  }

  stop(): void {
    this.fusion.stop()
  }

  /** Feeds the models with the measurements the fusion picked since the last call. */
  private learn(): void {
    for (const m of this.fusion.flush()) {
      this.models
        .get(m.segmentId)
        ?.observe({ contagem: m.contagem, velocidadeMediaKmh: m.velocidadeMediaKmh, comprimentoM: m.comprimentoCobertoM }, m.ts)
    }
  }

  /** Estimate per segment. */
  snapshot(): Record<string, Estimate> {
    this.learn()
    const now = this.now()
    return Object.fromEntries([...this.models].map(([id, m]) => [id, m.estimate(now)]))
  }
}
