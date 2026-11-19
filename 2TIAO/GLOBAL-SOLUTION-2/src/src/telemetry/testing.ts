import { topicMatches, type ConnectionStatus, type PublishOptions, type TelemetryTransport } from './transport'

/** In-memory broker stand-in: delivers to subscribers only while "connected". */
export class FakeTransport implements TelemetryTransport {
  readonly published: { topic: string; payload: string; options: PublishOptions }[] = []
  private connected: boolean
  private statusListeners = new Set<(s: ConnectionStatus) => void>()
  private subscriptions = new Set<{ filter: string; handler: (topic: string, payload: string) => void }>()

  constructor(connected: boolean) {
    this.connected = connected
  }

  status(): ConnectionStatus {
    return this.connected ? 'connected' : 'disconnected'
  }

  onStatus(listener: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  setConnected(connected: boolean): void {
    this.connected = connected
    for (const l of this.statusListeners) l(this.status())
  }

  publish(topic: string, payload: string, options: PublishOptions): void {
    if (!this.connected) return
    this.published.push({ topic, payload, options })
    this.deliver(topic, payload)
  }

  /** Simulates a message arriving from the broker. */
  deliver(topic: string, payload: string): void {
    if (!this.connected) return
    for (const s of this.subscriptions) if (topicMatches(s.filter, topic)) s.handler(topic, payload)
  }

  subscribe(filter: string, handler: (topic: string, payload: string) => void): () => void {
    const entry = { filter, handler }
    this.subscriptions.add(entry)
    return () => this.subscriptions.delete(entry)
  }

  close(): void {}
}

/**
 * Delivers one segment's metrics as the plate matcher publishes them (door 2): density `k`
 * (veh/km), pair speed `v` (km/h) and, unless given, the flow k x v in cars/min.
 */
export function deliverMetrics(
  transport: FakeTransport,
  trecho: string,
  ts: number,
  { k, v, fluxoVeicMin, ocupacao = 0, pares }: { k: number; v: number | null; fluxoVeicMin?: number; ocupacao?: number; pares?: number },
): void {
  transport.deliver(
    `transito/vias/${trecho}/metricas`,
    JSON.stringify({
      trecho,
      ts,
      janelaS: 60,
      fluxoVeicMin: fluxoVeicMin ?? (v === null ? 0 : (k * v) / 60),
      velocidadeMediaKmh: v,
      pares: pares ?? (v === null ? 0 : 1),
      entraram: 0,
      sairam: 0,
      ocupacao,
      densidadeVeicKm: k,
      camerasPar: ['C99E', 'C99S'],
    }),
  )
}
