import { buildSegments, type Segment } from '../sensors/segments'
import { buildRoadNetwork } from '../sim/roadNetwork'
import { FusionService } from '../fusion/FusionService'
import type { TelemetryTransport } from '../telemetry/transport'
import { CapacityModel, SPEED_LIMIT_KMH, type Estimate, type RouteStatus } from './CapacityModel'

/** A route seen through its segments, for the diversion decision. */
export interface RouteSummary {
  estado: RouteStatus
  velocidade: number | null
  fluxo: number
  capacidade: number | null
  folga: number | null
}

/**
 * A route is as good as its bottleneck: state, speed and flow of its segment with data and the
 * lowest speed (an empty segment counts as free flow); capacity and slack are the minimum over its
 * segments with a capacity. No segment with data -> "sem dados".
 */
export function summariseRoute(routeId: string, segments: readonly Segment[], estimates: Record<string, Estimate>): RouteSummary {
  const mine = segments.filter((s) => s.routeIds.includes(routeId)).map((s) => estimates[s.id]).filter(Boolean)
  const withData = mine.filter((e) => e.estado !== 'sem dados')
  if (withData.length === 0) return { estado: 'sem dados', velocidade: null, fluxo: 0, capacidade: null, folga: null }
  const speedOf = (e: Estimate) => e.velocidade ?? SPEED_LIMIT_KMH
  const bottleneck = withData.reduce((a, b) => (speedOf(b) < speedOf(a) ? b : a))
  const caps = mine.filter((e) => e.capacidade !== null)
  const slacks = mine.filter((e) => e.folga !== null)
  return {
    estado: bottleneck.estado,
    velocidade: bottleneck.velocidade,
    fluxo: bottleneck.fluxo,
    capacidade: caps.length ? Math.min(...caps.map((e) => e.capacidade!)) : null,
    folga: slacks.length ? Math.min(...slacks.map((e) => e.folga!)) : null,
  }
}

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
    this.segments = segments ?? buildSegments(buildRoadNetwork())
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

  /** Each route summarised by its bottleneck segment, for the diversion decision. */
  routes(): Record<string, RouteSummary> {
    const estimates = this.snapshot()
    const routeIds = [...new Set(this.segments.flatMap((s) => s.routeIds))]
    return Object.fromEntries(routeIds.map((id) => [id, summariseRoute(id, this.segments, estimates)]))
  }
}
