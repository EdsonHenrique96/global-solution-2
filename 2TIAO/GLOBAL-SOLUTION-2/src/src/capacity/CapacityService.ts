import { buildSegments, type Segment } from '../sensors/segments'
import { buildRoadNetwork } from '../sim/roadNetwork'
import { TELEMETRY_FILTER } from '../telemetry/TelemetryPublisher'
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
 * One capacity model per road segment (AD-022), fed only by what arrives on the MQTT
 * subscription (AD-005). `now` is the simulation clock, so staleness keeps counting while the
 * broker is down.
 */
export class CapacityService {
  private readonly transport: TelemetryTransport
  private readonly now: () => number
  readonly segments: readonly Segment[]
  private readonly models: Map<string, CapacityModel>
  private unsubscribe: (() => void) | null = null

  constructor(transport: TelemetryTransport, now: () => number, segments?: readonly Segment[]) {
    this.transport = transport
    this.now = now
    this.segments = segments ?? buildSegments(buildRoadNetwork())
    this.models = new Map(this.segments.map((s) => [s.id, new CapacityModel()]))
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.transport.subscribe(TELEMETRY_FILTER, (_topic, payload) => this.receive(payload))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private receive(payload: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(payload)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const { ts, porTrecho } = msg as { ts?: unknown; porTrecho?: unknown }
    if (typeof ts !== 'number' || !Array.isArray(porTrecho)) return
    for (const entry of porTrecho) {
      if (!entry || typeof entry !== 'object') continue
      const { trecho, contagem, velocidadeMediaKmh, comprimentoCobertoM } = entry as Record<string, unknown>
      const model = typeof trecho === 'string' ? this.models.get(trecho) : undefined
      if (!model || typeof contagem !== 'number' || typeof comprimentoCobertoM !== 'number') continue
      if (velocidadeMediaKmh !== null && typeof velocidadeMediaKmh !== 'number') continue
      model.observe({ contagem, velocidadeMediaKmh, comprimentoM: comprimentoCobertoM }, ts)
    }
  }

  /** Estimate per segment. */
  snapshot(): Record<string, Estimate> {
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
