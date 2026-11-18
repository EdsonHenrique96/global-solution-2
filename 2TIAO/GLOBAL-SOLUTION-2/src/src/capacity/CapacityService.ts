import { TELEMETRY_FILTER } from '../telemetry/TelemetryPublisher'
import type { TelemetryTransport } from '../telemetry/transport'
import { CapacityModel, type Estimate } from './CapacityModel'

export const ROUTE_IDS = ['central', 'norte', 'sul'] as const

/**
 * One capacity model per route, fed only by what arrives on the MQTT subscription (AD-005).
 * `now` is the simulation clock, so staleness keeps counting while the broker is down.
 */
export class CapacityService {
  private readonly transport: TelemetryTransport
  private readonly now: () => number
  private readonly models = new Map<string, CapacityModel>(ROUTE_IDS.map((id) => [id, new CapacityModel()]))
  private unsubscribe: (() => void) | null = null

  constructor(transport: TelemetryTransport, now: () => number) {
    this.transport = transport
    this.now = now
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
    const { ts, porVia } = msg as { ts?: unknown; porVia?: unknown }
    if (typeof ts !== 'number' || !Array.isArray(porVia)) return
    for (const entry of porVia) {
      if (!entry || typeof entry !== 'object') continue
      const { via, contagem, velocidadeMediaKmh, comprimentoM } = entry as Record<string, unknown>
      const model = typeof via === 'string' ? this.models.get(via) : undefined
      if (!model || typeof contagem !== 'number' || typeof comprimentoM !== 'number') continue
      if (velocidadeMediaKmh !== null && typeof velocidadeMediaKmh !== 'number') continue
      model.observe({ contagem, velocidadeMediaKmh, comprimentoM }, ts)
    }
  }

  snapshot(): Record<string, Estimate> {
    const now = this.now()
    return Object.fromEntries([...this.models].map(([id, m]) => [id, m.estimate(now)]))
  }
}
